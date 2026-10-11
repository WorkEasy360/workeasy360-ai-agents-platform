import { sql, type SQL } from "drizzle-orm";
import { adminDb } from "@we360/db";
import { logger } from "../../lib/logger";
import { deleteObject, deletePrefix, knowledgeBasePrefix } from "../../lib/storage";

/* Nightly retention and purge jobs, run by the worker (maintenance queue). */

/** Runs a batched delete until fewer than `batch` rows are affected. Keeps locks and WAL bursts short. */
async function deleteInBatches(statement: (batch: number) => SQL, batch = 5000): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await adminDb().execute(statement(batch));
    total += result.rowCount ?? 0;
    if ((result.rowCount ?? 0) < batch) return total;
  }
}

/**
 * Nightly retention:
 * - run logs (executions + steps) older than the plan's log retention, or the org's conversation
 *   retention if that is shorter (run logs hold previews of the chat text);
 * - conversations (+ messages) with no activity for longer than the org's conversation retention.
 */
export async function applyRetention() {
  const runs = await deleteInBatches(
    (n) => sql`
      with doomed as (
        select e.id from executions e
        join organization o on o.id = e.org_id
        join plans p on p.key = o.plan_key
        where e.started_at < now() - make_interval(days => least(
          coalesce((o.plan_overrides->>'logRetentionDays')::int, (p.limits->>'logRetentionDays')::int, 30),
          o.conversation_retention_days))
        limit ${n}
      )
      delete from executions where id in (select id from doomed)
    `,
  );
  const convs = await deleteInBatches(
    (n) => sql`
      with doomed as (
        select c.id from conversations c
        join organization o on o.id = c.org_id
        where coalesce(c.last_message_at, c.created_at) < now() - make_interval(days => o.conversation_retention_days)
        limit ${n}
      )
      delete from conversations where id in (select id from doomed)
    `,
  );
  const audit = await applyAuditRetention();
  logger.info({ runs, conversations: convs, ...audit }, "retention applied");
}

/** Audit entries are kept for AUDIT_RETENTION_DAYS (default 1 year); who-did-what stays, network details don't. */
const AUDIT_RETENTION_DAYS = Number(process.env.AUDIT_RETENTION_DAYS ?? 365);
const AUDIT_IP_DAYS = 90;

export async function applyAuditRetention() {
  const db = adminDb();
  // IP address and browser are only needed while an incident could still be investigated.
  const anonymized = await db.execute(sql`
    update audit_logs set ip = null, user_agent = null
    where created_at < now() - make_interval(days => ${AUDIT_IP_DAYS}) and (ip is not null or user_agent is not null)`);
  // Deleted organizations: keep the bare record (action, target id, time), drop details and network data.
  const orphaned = await db.execute(sql`
    update audit_logs a set ip = null, user_agent = null, diff = null
    where a.org_id is not null and (a.ip is not null or a.user_agent is not null or a.diff is not null)
      and not exists (select 1 from organization o where o.id = a.org_id)`);
  const deleted = await deleteInBatches(
    (n) => sql`delete from audit_logs where id in (
      select id from audit_logs where created_at < now() - make_interval(days => ${AUDIT_RETENTION_DAYS}) limit ${n})`,
  );
  return { auditAnonymized: anonymized.rowCount ?? 0, auditOrphansStripped: orphaned.rowCount ?? 0, auditDeleted: deleted };
}

/** Soft-deleted rows are kept for 30 days (undo window, support), then removed for good. */
const PURGE_AFTER = sql`now() - interval '30 days'`;

export async function purgeDeleted() {
  const db = adminDb();
  // Documents soft-deleted before hard deletes were introduced: remove their files too.
  const docs = await db.execute<{ storage_key: string | null }>(
    sql`delete from documents where deleted_at is not null returning storage_key`,
  );
  for (const d of docs.rows) if (d.storage_key) await deleteObject(d.storage_key).catch(() => undefined);
  // Any credential still soft-deleted (encrypted secrets are never kept).
  const creds = await db.execute(sql`delete from credentials where deleted_at is not null`);
  // Agents: deployments first (a pinned deployment restricts deleting its version), then the agent
  // (versions, conversations and messages cascade).
  await db.execute(sql`delete from deployments where agent_id in (select id from agents where deleted_at < ${PURGE_AFTER})`);
  const agentRows = await db.execute(sql`delete from agents where deleted_at < ${PURGE_AFTER}`);
  // Tools and knowledge bases still referenced by a (non-deleted) agent's version stay until it goes.
  const toolRows = await db.execute(sql`
    delete from tools t where t.deleted_at < ${PURGE_AFTER}
      and not exists (select 1 from agent_version_tools avt where avt.tool_id = t.id)`);
  const kbs = await db.execute<{ id: string; org_id: string }>(sql`
    delete from knowledge_bases kb where kb.deleted_at < ${PURGE_AFTER}
      and not exists (select 1 from agent_version_knowledge avk where avk.knowledge_base_id = kb.id)
    returning id, org_id`);
  for (const kb of kbs.rows) await deletePrefix(knowledgeBasePrefix(kb.org_id, kb.id)).catch(() => undefined);
  const templates = await db.execute(sql`delete from agent_templates where deleted_at < ${PURGE_AFTER}`);
  // Removed channels (their conversations keep running under retention; the link becomes null).
  const deps = await db.execute(sql`delete from deployments where deleted_at < ${PURGE_AFTER}`);
  logger.info(
    {
      documents: docs.rowCount,
      credentials: creds.rowCount,
      agents: agentRows.rowCount,
      tools: toolRows.rowCount,
      knowledgeBases: kbs.rowCount,
      templates: templates.rowCount,
      deployments: deps.rowCount,
    },
    "soft-deleted rows purged",
  );
}
