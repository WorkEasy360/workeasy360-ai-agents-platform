import { Router } from "express";
import { and, asc, desc, eq, gt, ilike, inArray, isNull, lt, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { appDb, withTenant } from "@we360/db";
import {
  agentVersions,
  agents,
  auditLogs,
  conversations,
  deployments,
  documents,
  knowledgeBases,
  messages,
  organization,
  tools,
  user,
} from "@we360/db/schema";
import { audit, parse, tenantOf } from "../../lib/http";
import { requireRole, requireSession, requireTenant } from "../../middleware/auth";

/** Organization-level features: audit log and data export (DPDP / GDPR portability). */
export const organizationRouter = Router();
organizationRouter.use(requireSession, requireTenant);

organizationRouter.get("/audit-logs", requireRole("admin"), async (req, res) => {
  const { orgId } = tenantOf(req);
  const q = parse(
    z.object({ action: z.string().max(100).optional(), cursor: z.iso.datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }),
    req.query,
  );
  const where: SQL[] = [];
  if (q.action) where.push(ilike(auditLogs.action, `%${q.action}%`));
  if (q.cursor) where.push(lt(auditLogs.createdAt, new Date(q.cursor)));
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select({
        id: auditLogs.id,
        action: auditLogs.action,
        actorType: auditLogs.actorType,
        actorId: auditLogs.actorId,
        targetType: auditLogs.targetType,
        targetId: auditLogs.targetId,
        diff: auditLogs.diff,
        ip: auditLogs.ip,
        createdAt: auditLogs.createdAt,
      })
      .from(auditLogs)
      .where(and(...where))
      .orderBy(desc(auditLogs.createdAt))
      .limit(q.limit + 1),
  );
  // Actor names come from the user table (no RLS), looked up for this page only.
  const actorIds = [...new Set(rows.map((r) => r.actorId).filter((x): x is string => Boolean(x)))];
  const actors = actorIds.length
    ? await appDb().select({ id: user.id, name: user.name, email: user.email }).from(user).where(inArray(sql`${user.id}::text`, actorIds))
    : [];
  const page = rows.slice(0, q.limit).map((r) => {
    const a = actors.find((x) => x.id === r.actorId);
    // Platform staff actions are shown without naming the staff member.
    return { ...r, actorName: r.actorType === "platform_admin" ? "WorkEasy360 support" : (a?.name ?? null), actorEmail: r.actorType === "platform_admin" ? null : (a?.email ?? null) };
  });
  res.json({ data: page, nextCursor: rows.length > q.limit ? page.at(-1)!.createdAt.toISOString() : null });
});

/**
 * Streams a JSON export of everything the organization owns. Secrets (credentials, API keys)
 * are never included; uploaded files are listed by metadata only.
 */
organizationRouter.get("/export", requireRole("owner"), async (req, res) => {
  const { orgId } = tenantOf(req);
  const [org] = await appDb().select({ name: organization.name, slug: organization.slug, planKey: organization.planKey }).from(organization).where(eq(organization.id, orgId));
  await audit(req, { action: "organization.exported", targetType: "organization", targetId: orgId });

  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-disposition", `attachment; filename="${org?.slug ?? "organization"}-export-${new Date().toISOString().slice(0, 10)}.json"`);
  const write = (s: string) => res.write(s);

  const sections = await withTenant(orgId, async (tx) => ({
    agents: await tx.select().from(agents).where(isNull(agents.deletedAt)),
    agentVersions: await tx.select().from(agentVersions),
    knowledgeBases: await tx.select().from(knowledgeBases).where(isNull(knowledgeBases.deletedAt)),
    documents: await tx
      .select({ id: documents.id, knowledgeBaseId: documents.knowledgeBaseId, title: documents.title, sourceType: documents.sourceType, sourceUrl: documents.sourceUrl, mimeType: documents.mimeType, sizeBytes: documents.sizeBytes, status: documents.status, createdAt: documents.createdAt })
      .from(documents)
      .where(isNull(documents.deletedAt)),
    tools: await tx
      .select({ id: tools.id, providerKey: tools.providerKey, name: tools.name, description: tools.description, config: tools.config, createdAt: tools.createdAt })
      .from(tools)
      .where(isNull(tools.deletedAt)),
    deployments: await tx.select().from(deployments).where(isNull(deployments.deletedAt)),
  }));

  write(`{"exportedAt":${JSON.stringify(new Date().toISOString())},"organization":${JSON.stringify(org)}`);
  for (const [key, rows] of Object.entries(sections)) write(`,${JSON.stringify(key)}:${JSON.stringify(rows)}`);

  // Conversations can be large: stream them in pages.
  write(`,"conversations":[`);
  let cursor = new Date(0);
  let first = true;
  for (;;) {
    const batch = await withTenant(orgId, async (tx) => {
      const convs = await tx.select().from(conversations).where(gt(conversations.createdAt, cursor)).orderBy(asc(conversations.createdAt)).limit(200);
      const withMessages = [];
      for (const c of convs) {
        const msgs = await tx
          .select({ role: messages.role, content: messages.content, feedback: messages.feedback, createdAt: messages.createdAt })
          .from(messages)
          .where(eq(messages.conversationId, c.id))
          .orderBy(asc(messages.createdAt));
        withMessages.push({ ...c, messages: msgs });
      }
      return withMessages;
    });
    for (const c of batch) {
      write(`${first ? "" : ","}${JSON.stringify(c)}`);
      first = false;
    }
    if (batch.length < 200) break;
    cursor = batch.at(-1)!.createdAt;
  }
  write("]}");
  res.end();
});
