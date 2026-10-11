import { randomBytes } from "node:crypto";
import { Router, type Request } from "express";
import { and, asc, desc, eq, ilike, lt, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { adminDb } from "@we360/db";
import {
  agents,
  aiModels,
  auditLogs,
  deployments,
  executionSteps,
  executions,
  featureFlags,
  member,
  organization,
  plans,
  session,
  user,
} from "@we360/db/schema";
import { AppError } from "../../lib/errors";
import { parse, uuidParam } from "../../lib/http";
import { getIngestQueue } from "../../lib/queue";
import { auth } from "../../auth/auth";
import { deleteAccount } from "../../auth/hooks";
import { env } from "../../config/env";
import { clearModelCache } from "../models/catalog";
import { notify } from "../notifications/notify";
import { clearOrgLimits } from "../plans/plan-limits";
import { requireSession } from "../../middleware/auth";
import { requirePlatformRole } from "../../middleware/platform-admin";

/**
 * Super admin API (`/api/admin/v1`). Uses the RLS-bypassing connection, so every route here
 * stays behind `requirePlatformRole`. Every change is written to the audit log.
 * `support` can read everything and pause abusive agents; only `super_admin` changes plans,
 * bans users, edits models or flags.
 */
export const adminRouter = Router();
adminRouter.use(requireSession, requirePlatformRole("super_admin", "support"));
const superOnly = requirePlatformRole("super_admin");

const db = () => adminDb();

async function adminAudit(req: Request, action: string, target: { type: string; id: string; orgId?: string | null }, diff?: unknown) {
  await db()
    .insert(auditLogs)
    .values({
      orgId: target.orgId ?? null,
      actorType: "platform_admin",
      actorId: req.auth!.user.id,
      action: `admin.${action}`,
      targetType: target.type,
      targetId: target.id,
      diff,
      ip: req.ip,
      userAgent: req.header("user-agent")?.slice(0, 300),
    });
}

const pageSchema = z.object({
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

/* ---------------------------------- Overview ---------------------------------- */

adminRouter.get("/overview", async (_req, res) => {
  const result = await db().execute<Record<string, number | string>>(sql`
    select
      (select count(*) from organization)::int as organizations,
      (select count(*) from organization where status = 'suspended')::int as suspended_organizations,
      (select count(*) from "user")::int as users,
      (select count(*) from "user" where created_at >= now() - interval '7 days')::int as signups_7d,
      (select count(*) from agents where deleted_at is null and status = 'active')::int as active_agents,
      (select count(*) from executions where started_at >= date_trunc('day', now()))::int as runs_today,
      (select count(*) from executions where started_at >= now() - interval '30 days')::int as runs_30d,
      (select count(*) from executions where status = 'failed' and started_at >= date_trunc('day', now()))::int as failed_runs_today,
      (select coalesce(sum(cost_usd), 0)::text from usage_records
         where billing_source = 'platform' and occurred_at >= date_trunc('day', now())) as platform_cost_today_usd,
      (select coalesce(sum(cost_usd), 0)::text from usage_records
         where billing_source = 'platform' and occurred_at >= date_trunc('month', now())) as platform_cost_month_usd,
      (select coalesce(sum(cost_usd), 0)::text from usage_records
         where billing_source = 'byok' and occurred_at >= date_trunc('month', now())) as byok_cost_month_usd
  `);
  const signups = await db().execute<{ day: string; n: number }>(sql`
    select to_char(d, 'YYYY-MM-DD') as day, count(u.id)::int as n
    from generate_series(date_trunc('day', now()) - interval '29 days', date_trunc('day', now()), interval '1 day') d
    left join "user" u on date_trunc('day', u.created_at) = d
    group by d order by d
  `);
  res.json({ ...result.rows[0], signupsDaily: signups.rows });
});

/* -------------------------------- Organizations ------------------------------- */

adminRouter.get("/organizations", async (req, res) => {
  const q = parse(pageSchema.extend({ plan: z.string().optional(), status: z.enum(["active", "suspended"]).optional() }), req.query);
  const where: SQL[] = [];
  if (q.q) where.push(or(ilike(organization.name, `%${q.q}%`), ilike(organization.slug, `%${q.q}%`))!);
  if (q.plan) where.push(eq(organization.planKey, q.plan));
  if (q.status) where.push(eq(organization.status, q.status));
  const rows = await db()
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      planKey: organization.planKey,
      status: organization.status,
      createdAt: organization.createdAt,
      members: sql<number>`(select count(*) from member m where m.organization_id = "organization"."id")::int`,
      agents: sql<number>`(select count(*) from agents a where a.org_id = "organization"."id" and a.deleted_at is null)::int`,
      runs30d: sql<number>`(select count(*) from executions e where e.org_id = "organization"."id" and e.started_at >= now() - interval '30 days')::int`,
      costMonthUsd: sql<string>`(select coalesce(sum(cost_usd), 0)::text from usage_records u where u.org_id = "organization"."id" and u.billing_source = 'platform' and u.occurred_at >= date_trunc('month', now()))`,
    })
    .from(organization)
    .where(and(...where))
    .orderBy(desc(organization.createdAt))
    .limit(q.limit)
    .offset(q.offset);
  res.json({ data: rows });
});

adminRouter.get("/organizations/:id", async (req, res) => {
  const id = uuidParam(req, "id");
  const [org] = await db().select().from(organization).where(eq(organization.id, id));
  if (!org) throw AppError.notFound("Organization");
  const members = await db()
    .select({ userId: user.id, name: user.name, email: user.email, role: member.role, joinedAt: member.createdAt })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(eq(member.organizationId, id));
  const orgAgents = await db()
    .select({ id: agents.id, name: agents.name, status: agents.status, disabledByAdminAt: agents.disabledByAdminAt, updatedAt: agents.updatedAt })
    .from(agents)
    .where(and(eq(agents.orgId, id), sql`${agents.deletedAt} is null`))
    .orderBy(desc(agents.updatedAt));
  const usage = await db().execute<{ messages: number; platform_usd: string; byok_usd: string; storage_mb: string }>(sql`
    select
      (select count(*) from executions where org_id = ${id} and source <> 'playground' and started_at >= date_trunc('month', now()))::int as messages,
      (select coalesce(sum(cost_usd),0)::text from usage_records where org_id = ${id} and billing_source='platform' and occurred_at >= date_trunc('month', now())) as platform_usd,
      (select coalesce(sum(cost_usd),0)::text from usage_records where org_id = ${id} and billing_source='byok' and occurred_at >= date_trunc('month', now())) as byok_usd,
      (select (coalesce(sum(size_bytes),0)/1048576.0)::text from documents where org_id = ${id} and deleted_at is null) as storage_mb
  `);
  const byok = await db().execute<{ integration_key: string }>(
    sql`select integration_key from credentials where org_id = ${id} and integration_key like 'llm.%' and deleted_at is null`,
  );
  const [plan] = await db().select().from(plans).where(eq(plans.key, org.planKey));
  // Member names and emails are personal data: record who looked.
  await adminAudit(req, "organization.viewed", { type: "organization", id, orgId: id });
  res.json({
    ...org,
    plan,
    members,
    agents: orgAgents,
    usageThisMonth: usage.rows[0],
    byokProviders: byok.rows.map((r) => r.integration_key.replace("llm.", "")),
  });
});

const orgPatchSchema = z.object({
  planKey: z.string().optional(),
  status: z.enum(["active", "suspended"]).optional(),
  planOverrides: z.record(z.string(), z.unknown()).nullable().optional(),
  reason: z.string().max(500).optional(),
});

adminRouter.patch("/organizations/:id", superOnly, async (req, res) => {
  const id = uuidParam(req, "id");
  const body = parse(orgPatchSchema, req.body);
  if (body.planKey) {
    const [plan] = await db().select({ key: plans.key }).from(plans).where(eq(plans.key, body.planKey));
    if (!plan) throw AppError.badRequest("Unknown plan.");
  }
  const [before] = await db().select().from(organization).where(eq(organization.id, id));
  if (!before) throw AppError.notFound("Organization");
  const [after] = await db()
    .update(organization)
    .set({ planKey: body.planKey, status: body.status, planOverrides: body.planOverrides === undefined ? undefined : body.planOverrides })
    .where(eq(organization.id, id))
    .returning();
  clearOrgLimits(id);
  await adminAudit(req, "organization.updated", { type: "organization", id, orgId: id }, {
    reason: body.reason,
    before: { planKey: before.planKey, status: before.status, planOverrides: before.planOverrides },
    after: { planKey: after!.planKey, status: after!.status, planOverrides: after!.planOverrides },
  });
  if (body.status && body.status !== before.status) await notify.organizationStatus(id, after!.name, body.status);
  res.json(after);
});

/* ------------------------------------ Users ----------------------------------- */

adminRouter.get("/users", async (req, res) => {
  const q = parse(pageSchema, req.query);
  const rows = await db()
    .select({
      id: user.id,
      name: user.name,
      email: user.email,
      emailVerified: user.emailVerified,
      platformRole: user.platformRole,
      twoFactorEnabled: user.twoFactorEnabled,
      bannedAt: user.bannedAt,
      createdAt: user.createdAt,
      orgs: sql<number>`(select count(*) from member m where m.user_id = "user"."id")::int`,
      lastSeenAt: sql<string | null>`(select max(s.updated_at) from session s where s.user_id = "user"."id")`,
    })
    .from(user)
    .where(q.q ? or(ilike(user.email, `%${q.q}%`), ilike(user.name, `%${q.q}%`)) : undefined)
    .orderBy(desc(user.createdAt))
    .limit(q.limit)
    .offset(q.offset);
  res.json({ data: rows });
});

adminRouter.get("/users/:id", async (req, res) => {
  const id = uuidParam(req, "id");
  const [u] = await db().select().from(user).where(eq(user.id, id));
  if (!u) throw AppError.notFound("User");
  const orgs = await db()
    .select({ id: organization.id, name: organization.name, planKey: organization.planKey, role: member.role })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(eq(member.userId, id));
  const sessions = await db()
    .select({ id: session.id, createdAt: session.createdAt, updatedAt: session.updatedAt, ipAddress: session.ipAddress, userAgent: session.userAgent })
    .from(session)
    .where(eq(session.userId, id))
    .orderBy(desc(session.updatedAt))
    .limit(20);
  await adminAudit(req, "user.viewed", { type: "user", id });
  res.json({ ...u, organizations: orgs, sessions });
});

adminRouter.post("/users/:id/ban", superOnly, async (req, res) => {
  const id = uuidParam(req, "id");
  if (id === req.auth!.user.id) throw AppError.badRequest("You can't ban yourself.");
  const { reason } = parse(z.object({ reason: z.string().min(3).max(500) }), req.body);
  await db().update(user).set({ bannedAt: new Date(), banReason: reason }).where(eq(user.id, id));
  await db().delete(session).where(eq(session.userId, id));
  await adminAudit(req, "user.banned", { type: "user", id }, { reason });
  res.json({ ok: true });
});

adminRouter.post("/users/:id/unban", superOnly, async (req, res) => {
  const id = uuidParam(req, "id");
  await db().update(user).set({ bannedAt: null, banReason: null }).where(eq(user.id, id));
  await adminAudit(req, "user.unbanned", { type: "user", id });
  res.json({ ok: true });
});

/**
 * One-time password reset link (valid 1 hour) for a super admin to pass on, for when email is off or
 * hasn't arrived. Same token type and lifetime as the emailed link; the action is audited.
 */
adminRouter.post("/users/:id/password-reset-link", superOnly, async (req, res) => {
  const id = uuidParam(req, "id");
  const [u] = await db().select({ id: user.id }).from(user).where(eq(user.id, id));
  if (!u) throw AppError.notFound("User");
  const token = randomBytes(18).toString("base64url");
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
  const ctx = await auth.$context;
  await ctx.internalAdapter.createVerificationValue({ value: id, identifier: `reset-password:${token}`, expiresAt });
  await adminAudit(req, "user.password_reset_link_created", { type: "user", id });
  res.json({ url: `${env.APP_URL}/reset-password?token=${token}`, expiresAt: expiresAt.toISOString() });
});

adminRouter.post("/users/:id/revoke-sessions", superOnly, async (req, res) => {
  const id = uuidParam(req, "id");
  await db().delete(session).where(eq(session.userId, id));
  await adminAudit(req, "user.sessions_revoked", { type: "user", id });
  res.json({ ok: true });
});

/** Erasure request received by support: deletes the account (see deleteAccount for what goes with it). */
adminRouter.delete("/users/:id", superOnly, async (req, res) => {
  const id = uuidParam(req, "id");
  if (id === req.auth!.user.id) throw AppError.badRequest("You can't delete your own account here.");
  const [u] = await db().select({ id: user.id }).from(user).where(eq(user.id, id));
  if (!u) throw AppError.notFound("User");
  try {
    await deleteAccount(id, { deleteUserRow: true, actor: { type: "platform_admin", id: req.auth!.user.id } });
  } catch (err) {
    if (err instanceof Error && "body" in err) throw AppError.badRequest(err.message);
    throw err;
  }
  res.status(204).end();
});

adminRouter.post("/users/:id/platform-role", superOnly, async (req, res) => {
  const id = uuidParam(req, "id");
  const { role } = parse(z.object({ role: z.enum(["super_admin", "support"]).nullable() }), req.body);
  if (id === req.auth!.user.id && role !== "super_admin") throw AppError.badRequest("You can't remove your own super admin role.");
  await db().update(user).set({ platformRole: role }).where(eq(user.id, id));
  await adminAudit(req, "user.platform_role_changed", { type: "user", id }, { role });
  res.json({ ok: true });
});

/* ------------------------------------ Agents ---------------------------------- */

adminRouter.get("/agents", async (req, res) => {
  const q = parse(pageSchema.extend({ orgId: z.uuid().optional() }), req.query);
  const where: SQL[] = [sql`${agents.deletedAt} is null`];
  if (q.q) where.push(ilike(agents.name, `%${q.q}%`));
  if (q.orgId) where.push(eq(agents.orgId, q.orgId));
  const rows = await db()
    .select({
      id: agents.id,
      name: agents.name,
      orgId: agents.orgId,
      orgName: organization.name,
      status: agents.status,
      disabledByAdminAt: agents.disabledByAdminAt,
      updatedAt: agents.updatedAt,
      runs30d: sql<number>`(select count(*) from executions e where e.agent_id = "agents"."id" and e.started_at >= now() - interval '30 days')::int`,
    })
    .from(agents)
    .innerJoin(organization, eq(organization.id, agents.orgId))
    .where(and(...where))
    .orderBy(desc(agents.updatedAt))
    .limit(q.limit)
    .offset(q.offset);
  res.json({ data: rows });
});

/** Disabling stops every channel immediately; the org can't re-enable it. */
adminRouter.post("/agents/:id/disable", async (req, res) => {
  const id = uuidParam(req, "id");
  const { reason } = parse(z.object({ reason: z.string().min(3).max(500) }), req.body);
  const [a] = await db().update(agents).set({ disabledByAdminAt: new Date() }).where(eq(agents.id, id)).returning({ orgId: agents.orgId });
  if (!a) throw AppError.notFound("Agent");
  await db().update(deployments).set({ status: "disabled_by_admin" }).where(and(eq(deployments.agentId, id), sql`${deployments.deletedAt} is null`));
  await adminAudit(req, "agent.disabled", { type: "agent", id, orgId: a.orgId }, { reason });
  res.json({ ok: true });
});

adminRouter.post("/agents/:id/enable", superOnly, async (req, res) => {
  const id = uuidParam(req, "id");
  const [a] = await db().update(agents).set({ disabledByAdminAt: null }).where(eq(agents.id, id)).returning({ orgId: agents.orgId });
  if (!a) throw AppError.notFound("Agent");
  await db()
    .update(deployments)
    .set({ status: "active" })
    .where(and(eq(deployments.agentId, id), eq(deployments.status, "disabled_by_admin")));
  await adminAudit(req, "agent.enabled", { type: "agent", id, orgId: a.orgId });
  res.json({ ok: true });
});

/* --------------------------------- Executions --------------------------------- */

adminRouter.get("/executions", async (req, res) => {
  const q = parse(
    z.object({
      orgId: z.uuid().optional(),
      agentId: z.uuid().optional(),
      status: z.string().optional(),
      minCostUsd: z.coerce.number().optional(),
      cursor: z.iso.datetime().optional(),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }),
    req.query,
  );
  const where: SQL[] = [];
  if (q.orgId) where.push(eq(executions.orgId, q.orgId));
  if (q.agentId) where.push(eq(executions.agentId, q.agentId));
  if (q.status) where.push(eq(executions.status, q.status));
  if (q.minCostUsd !== undefined) where.push(sql`${executions.costUsd} >= ${q.minCostUsd}`);
  if (q.cursor) where.push(lt(executions.startedAt, new Date(q.cursor)));
  const rows = await db()
    .select({
      id: executions.id,
      orgId: executions.orgId,
      orgName: organization.name,
      agentId: executions.agentId,
      agentName: agents.name,
      source: executions.source,
      status: executions.status,
      errorCode: executions.errorCode,
      inputTokens: executions.inputTokens,
      outputTokens: executions.outputTokens,
      costUsd: executions.costUsd,
      latencyMs: executions.latencyMs,
      startedAt: executions.startedAt,
    })
    .from(executions)
    .leftJoin(organization, eq(organization.id, executions.orgId))
    .leftJoin(agents, eq(agents.id, executions.agentId))
    .where(and(...where))
    .orderBy(desc(executions.startedAt))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  res.json({ data: page, nextCursor: rows.length > q.limit ? page.at(-1)!.startedAt.toISOString() : null });
});

/** Trace content is customer data: every view is audited. */
adminRouter.get("/executions/:id", async (req, res) => {
  const id = uuidParam(req, "id");
  const [exec] = await db().select().from(executions).where(eq(executions.id, id));
  if (!exec) throw AppError.notFound("Execution");
  const steps = await db().select().from(executionSteps).where(eq(executionSteps.executionId, id)).orderBy(asc(executionSteps.seq));
  await adminAudit(req, "execution.viewed", { type: "execution", id, orgId: exec.orgId });
  res.json({ ...exec, steps });
});

/* ------------------------------------ Usage ----------------------------------- */

adminRouter.get("/usage", async (req, res) => {
  const { days } = parse(z.object({ days: z.coerce.number().int().min(1).max(90).default(30) }), req.query);
  const byModel = await db().execute(sql`
    select provider, model_key, billing_source, kind,
      sum(input_tokens)::bigint as input_tokens, sum(output_tokens)::bigint as output_tokens, sum(cost_usd)::float as cost_usd
    from usage_records where occurred_at >= now() - make_interval(days => ${days})
    group by 1,2,3,4 order by cost_usd desc
  `);
  const byDay = await db().execute(sql`
    select to_char(date_trunc('day', occurred_at), 'YYYY-MM-DD') as day,
      coalesce(sum(cost_usd) filter (where billing_source = 'platform'), 0)::float as platform_usd,
      coalesce(sum(cost_usd) filter (where billing_source = 'byok'), 0)::float as byok_usd
    from usage_records where occurred_at >= now() - make_interval(days => ${days})
    group by 1 order by 1
  `);
  const topOrgs = await db().execute(sql`
    select u.org_id, o.name, o.plan_key, sum(u.cost_usd)::float as platform_usd, count(distinct u.execution_id)::int as runs
    from usage_records u join organization o on o.id = u.org_id
    where u.billing_source = 'platform' and u.occurred_at >= now() - make_interval(days => ${days})
    group by 1,2,3 order by platform_usd desc limit 20
  `);
  res.json({ days, byModel: byModel.rows, byDay: byDay.rows, topOrgs: topOrgs.rows });
});

/* ------------------------------------ Plans ----------------------------------- */

adminRouter.get("/plans", async (_req, res) => {
  res.json({ data: await db().select().from(plans).orderBy(asc(plans.sortOrder)) });
});

const limitsSchema = z.object({
  agents: z.number().int().min(0).nullable(),
  messagesPerMonth: z.number().int().min(0).nullable(),
  platformCreditsUsdPerMonth: z.number().min(0).nullable(),
  knowledgeStorageMb: z.number().int().min(0).nullable(),
  members: z.number().int().min(1).nullable(),
  modelTiers: z.array(z.enum(["fast", "balanced", "premium"])).min(1),
  channels: z.array(z.enum(["hosted_page", "web_widget", "api"])),
  removeBranding: z.boolean(),
  logRetentionDays: z.number().int().min(1).max(3650),
});

adminRouter.patch("/plans/:key", superOnly, async (req, res) => {
  const key = String(req.params.key);
  const body = parse(z.object({ name: z.string().min(1).max(60).optional(), limits: limitsSchema.optional(), isPublic: z.boolean().optional() }), req.body);
  const [before] = await db().select().from(plans).where(eq(plans.key, key));
  if (!before) throw AppError.notFound("Plan");
  const [after] = await db().update(plans).set(body).where(eq(plans.key, key)).returning();
  clearOrgLimits();
  await adminAudit(req, "plan.updated", { type: "plan", id: key }, { before, after });
  res.json(after);
});

/* ------------------------------------ Models ---------------------------------- */

adminRouter.get("/models", async (_req, res) => {
  const rows = await db().select().from(aiModels).orderBy(asc(aiModels.kind), asc(aiModels.provider), asc(aiModels.displayName));
  const keys = { openai: Boolean(process.env.OPENAI_API_KEY), anthropic: Boolean(process.env.ANTHROPIC_API_KEY), google: Boolean(process.env.GOOGLE_GENERATIVE_AI_API_KEY) };
  res.json({ data: rows, platformKeys: keys, mockMode: process.env.MOCK_LLM === "true" });
});

const modelSchema = z.object({
  provider: z.enum(["openai", "anthropic", "google"]),
  modelKey: z.string().min(1).max(100),
  displayName: z.string().min(1).max(100),
  tier: z.enum(["fast", "balanced", "premium"]),
  kind: z.enum(["chat", "embedding"]).default("chat"),
  contextWindow: z.number().int().min(1000),
  inputPricePerMtokUsd: z.number().min(0),
  outputPricePerMtokUsd: z.number().min(0),
  capabilities: z.object({ tools: z.boolean().optional(), vision: z.boolean().optional(), temperature: z.boolean().optional() }).default({}),
  isEnabled: z.boolean().default(true),
});

adminRouter.post("/models", superOnly, async (req, res) => {
  const body = parse(modelSchema, req.body);
  const [row] = await db()
    .insert(aiModels)
    .values({ ...body, inputPricePerMtokUsd: String(body.inputPricePerMtokUsd), outputPricePerMtokUsd: String(body.outputPricePerMtokUsd) })
    .returning();
  clearModelCache();
  await adminAudit(req, "model.created", { type: "model", id: row!.id }, body);
  res.status(201).json(row);
});

adminRouter.patch("/models/:id", superOnly, async (req, res) => {
  const id = uuidParam(req, "id");
  const body = parse(modelSchema.partial().extend({ isDefault: z.boolean().optional() }), req.body);
  const row = await db().transaction(async (tx) => {
    if (body.isDefault) await tx.update(aiModels).set({ isDefault: false }).where(eq(aiModels.kind, "chat"));
    const [r] = await tx
      .update(aiModels)
      .set({
        ...body,
        inputPricePerMtokUsd: body.inputPricePerMtokUsd === undefined ? undefined : String(body.inputPricePerMtokUsd),
        outputPricePerMtokUsd: body.outputPricePerMtokUsd === undefined ? undefined : String(body.outputPricePerMtokUsd),
      })
      .where(eq(aiModels.id, id))
      .returning();
    return r;
  });
  clearModelCache();
  if (!row) throw AppError.notFound("Model");
  await adminAudit(req, "model.updated", { type: "model", id }, body);
  res.json(row);
});

/* -------------------------------- Feature flags ------------------------------- */

adminRouter.get("/feature-flags", async (_req, res) => {
  res.json({ data: await db().select().from(featureFlags).orderBy(asc(featureFlags.key)) });
});

adminRouter.patch("/feature-flags/:key", superOnly, async (req, res) => {
  const key = String(req.params.key);
  const body = parse(z.object({ defaultEnabled: z.boolean().optional(), orgOverrides: z.record(z.uuid(), z.boolean()).optional() }), req.body);
  const [row] = await db().update(featureFlags).set(body).where(eq(featureFlags.key, key)).returning();
  if (!row) throw AppError.notFound("Feature flag");
  await adminAudit(req, "feature_flag.updated", { type: "feature_flag", id: key }, body);
  res.json(row);
});

/* -------------------------------- System health ------------------------------- */

adminRouter.get("/health", async (_req, res) => {
  const dbStart = Date.now();
  await db().execute(sql`select 1`);
  const dbLatencyMs = Date.now() - dbStart;
  let queue: Record<string, number> | { error: string };
  try {
    queue = await getIngestQueue().getJobCounts("waiting", "active", "completed", "failed", "delayed");
  } catch (err) {
    queue = { error: (err as Error).message };
  }
  const providerErrors = await db().execute(sql`
    select error_code, count(*)::int as n from executions
    where status = 'failed' and started_at >= now() - interval '24 hours'
    group by 1 order by 2 desc limit 10
  `);
  const ingestion = await db().execute(sql`
    select status, count(*)::int as n from documents where deleted_at is null and updated_at >= now() - interval '7 days' group by 1
  `);
  res.json({ api: "ok", dbLatencyMs, ingestQueue: queue, failuresLast24h: providerErrors.rows, documentsLast7d: ingestion.rows, uptimeSec: Math.round(process.uptime()) });
});

/* ------------------------------------ Audit ----------------------------------- */

adminRouter.get("/audit-logs", async (req, res) => {
  const q = parse(
    z.object({
      orgId: z.uuid().optional(),
      actorType: z.string().optional(),
      action: z.string().max(100).optional(),
      cursor: z.iso.datetime().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(100),
    }),
    req.query,
  );
  const where: SQL[] = [];
  if (q.orgId) where.push(eq(auditLogs.orgId, q.orgId));
  if (q.actorType) where.push(eq(auditLogs.actorType, q.actorType));
  if (q.action) where.push(ilike(auditLogs.action, `%${q.action}%`));
  if (q.cursor) where.push(lt(auditLogs.createdAt, new Date(q.cursor)));
  const rows = await db()
    .select({ log: auditLogs, actorEmail: user.email, orgName: organization.name })
    .from(auditLogs)
    .leftJoin(user, sql`${user.id}::text = ${auditLogs.actorId}`)
    .leftJoin(organization, eq(organization.id, auditLogs.orgId))
    .where(and(...where))
    .orderBy(desc(auditLogs.createdAt))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit).map((r) => ({ ...r.log, actorEmail: r.actorEmail, orgName: r.orgName }));
  res.json({ data: page, nextCursor: rows.length > q.limit ? page.at(-1)!.createdAt.toISOString() : null });
});

