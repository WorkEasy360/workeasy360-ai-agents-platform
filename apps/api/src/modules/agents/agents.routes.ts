import { Router } from "express";
import { and, count, desc, eq, gte, inArray, isNull, max, sql } from "drizzle-orm";
import { z } from "zod";
import { withTenant } from "@we360/db";
import {
  agentTemplates as agentTemplateRows,
  aiModels,
  agentVersionKnowledge,
  agentVersions,
  agentVersionTools,
  agents,
  deployments,
  executions,
  knowledgeBases,
  tools,
} from "@we360/db/schema";
import { AppError } from "../../lib/errors";
import { audit, openSse, parse, tenantOf, uuidParam } from "../../lib/http";
import { requireRole, requireSession, requireTenant } from "../../middleware/auth";
import { getDefaultModelForTiers, listChatModels } from "../models/catalog";
import { usableProviders } from "../models/gateway";
import { getOrgLimits } from "../plans/plan-limits";
import { prepareRun, streamRun } from "../runs/run.service";
import { assertWithinLimit, lockAndAssertWithinLimit } from "../usage/usage.service";
import { draftSchema, generateAgentDraft } from "./agent-generator";
import { CUSTOM_TEMPLATE_PREFIX, loadCustomTemplate } from "./agent-templates.routes";
import { perUserLimit, rateLimit } from "../../lib/rate-limit";
import { hashConfig } from "./agent-config";
import { agentConfigSchema, agentTemplates, parseAgentConfig, publishProblems, templateConfig } from "./agent-config";

export const agentsRouter = Router();
agentsRouter.use(requireSession, requireTenant);

async function loadAgent(orgId: string, id: string) {
  const [agent] = await withTenant(orgId, (tx) =>
    tx
      .select()
      .from(agents)
      .where(and(eq(agents.id, id), isNull(agents.deletedAt))),
  );
  if (!agent) throw AppError.notFound("Agent");
  return agent;
}

/** Built-in templates plus this workspace's saved ones (keys "custom:<id>"). */
agentsRouter.get("/templates", async (req, res) => {
  const { orgId, workspaceId } = tenantOf(req);
  const custom = await withTenant(orgId, (tx) =>
    tx
      .select({ id: agentTemplateRows.id, name: agentTemplateRows.name, description: agentTemplateRows.description })
      .from(agentTemplateRows)
      .where(and(eq(agentTemplateRows.workspaceId, workspaceId), isNull(agentTemplateRows.deletedAt)))
      .orderBy(desc(agentTemplateRows.updatedAt)),
  );
  res.json({
    data: [
      ...custom.map((t) => ({ key: `${CUSTOM_TEMPLATE_PREFIX}${t.id}`, id: t.id, name: t.name, description: t.description ?? "", custom: true })),
      ...agentTemplates.map(({ key, name, description }) => ({ key, name, description, custom: false })),
    ],
  });
});

agentsRouter.get("/", async (req, res) => {
  const { orgId } = tenantOf(req);
  const since = new Date(Date.now() - 30 * 86_400_000);
  const rows = await withTenant(orgId, async (tx) => {
    const list = await tx
      .select({
        id: agents.id,
        name: agents.name,
        description: agents.description,
        avatarUrl: agents.avatarUrl,
        status: agents.status,
        disabledByAdmin: sql<boolean>`${agents.disabledByAdminAt} is not null`,
        modelId: sql<string>`${agents.draftConfig}->'model'->>'modelId'`,
        publishedVersionNo: agentVersions.versionNo,
        updatedAt: agents.updatedAt,
      })
      .from(agents)
      .leftJoin(agentVersions, eq(agentVersions.id, agents.publishedVersionId))
      .where(isNull(agents.deletedAt))
      .orderBy(desc(agents.updatedAt));
    const stats = await tx
      .select({
        agentId: executions.agentId,
        runs: count(),
        succeeded: sql<number>`count(*) filter (where ${executions.status} = 'succeeded')::int`,
      })
      .from(executions)
      .where(and(gte(executions.startedAt, since), sql`${executions.source} <> 'playground'`))
      .groupBy(executions.agentId);
    const deploymentCounts = await tx
      .select({ agentId: deployments.agentId, n: count() })
      .from(deployments)
      .where(isNull(deployments.deletedAt))
      .groupBy(deployments.agentId);
    return list.map((a) => {
      const s = stats.find((x) => x.agentId === a.id);
      return {
        ...a,
        runs30d: s?.runs ?? 0,
        successRate30d: s && s.runs ? s.succeeded / s.runs : null,
        deployments: deploymentCounts.find((d) => d.agentId === a.id)?.n ?? 0,
      };
    });
  });
  const models = await withTenant(orgId, (tx) => tx.select({ id: aiModels.id, name: aiModels.displayName }).from(aiModels));
  res.json({ data: rows.map((r) => ({ ...r, modelName: models.find((m) => m.id === r.modelId)?.name ?? null })) });
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().max(500).optional(),
  templateKey: z.string().optional(),
  /** Output of POST /generate, possibly edited by the user. */
  draft: draftSchema.partial().optional(),
});

/** "Describe your agent": returns a suggested configuration (nothing is saved). */
agentsRouter.post("/generate", rateLimit({ name: "agent-generate", limit: 10, windowSec: 60, key: (req) => req.auth?.user.id ?? req.ip ?? "" }), async (req, res) => {
  const { orgId } = tenantOf(req);
  const { description } = parse(z.object({ description: z.string().trim().min(10, "Describe the agent in a sentence or two.").max(4000) }), req.body);
  res.json(await generateAgentDraft(orgId, description));
});

agentsRouter.post("/", async (req, res) => {
  const { orgId, workspaceId } = tenantOf(req);
  const body = parse(createSchema, req.body);
  await assertWithinLimit(orgId, "agents");
  const defaultModel = await getDefaultModelForTiers((await getOrgLimits(orgId)).modelTiers, await usableProviders(orgId));
  let { config: base, template } = templateConfig(body.templateKey, defaultModel?.id ?? "");
  if (body.templateKey?.startsWith(CUSTOM_TEMPLATE_PREFIX)) {
    const custom = await loadCustomTemplate(orgId, body.templateKey.slice(CUSTOM_TEMPLATE_PREFIX.length));
    // Keep the template's model only if this org can still use it.
    const models = await listChatModels();
    const usable = await usableProviders(orgId);
    const tiers = (await getOrgLimits(orgId)).modelTiers;
    const m = models.find((x) => x.id === custom.config.model.modelId);
    const modelOk = m && usable.has(m.provider as never) && tiers.includes(m.tier as never);
    base = { ...custom.config, model: { ...custom.config.model, modelId: modelOk ? custom.config.model.modelId : (defaultModel?.id ?? "") } };
    template = { key: body.templateKey, name: custom.name, description: custom.description ?? "", config: custom.config };
  }
  const config = body.draft
    ? parseAgentConfig({
        ...base,
        identity: { ...base.identity, role: body.draft.role ?? base.identity.role, tone: body.draft.tone ?? base.identity.tone },
        instructions: body.draft.instructions ?? base.instructions,
        messages: { ...base.messages, welcome: body.draft.welcomeMessage ?? base.messages.welcome },
      })
    : base;
  const agent = await withTenant(orgId, async (tx) => {
    await lockAndAssertWithinLimit(tx, orgId, "agents");
    const [row] = await tx
      .insert(agents)
      .values({
        orgId,
        workspaceId,
        name: body.name,
        description: body.description ?? template?.description,
        draftConfig: config,
        templateKey: template?.key,
        createdBy: req.auth!.user.id,
      })
      .returning();
    await audit(req, { action: "agent.created", targetType: "agent", targetId: row!.id }, tx);
    return row!;
  });
  res.status(201).json(agent);
});

agentsRouter.get("/:id", async (req, res) => {
  const { orgId } = tenantOf(req);
  const agent = await loadAgent(orgId, uuidParam(req, "id"));
  const [published] = agent.publishedVersionId
    ? await withTenant(orgId, (tx) =>
        tx
          .select({ id: agentVersions.id, versionNo: agentVersions.versionNo, configHash: agentVersions.configHash, publishedAt: agentVersions.publishedAt })
          .from(agentVersions)
          .where(eq(agentVersions.id, agent.publishedVersionId!)),
      )
    : [];
  res.json({
    ...agent,
    publishedVersion: published ?? null,
    hasUnpublishedChanges: !published || published.configHash !== hashConfig(agent.draftConfig),
  });
});

const patchSchema = z.object({
  draftRevision: z.number().int(),
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().max(500).nullable().optional(),
  avatarUrl: z.url().max(2000).nullable().optional(),
  draftConfig: agentConfigSchema.optional(),
});

/** Autosave. `draftRevision` must match the stored one, so concurrent editors don't overwrite each other. */
agentsRouter.patch("/:id", async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  const body = parse(patchSchema, req.body);
  await loadAgent(orgId, id);
  const [updated] = await withTenant(orgId, (tx) =>
    tx
      .update(agents)
      .set({
        name: body.name,
        description: body.description,
        avatarUrl: body.avatarUrl,
        draftConfig: body.draftConfig ? parseAgentConfig(body.draftConfig) : undefined,
        draftRevision: sql`${agents.draftRevision} + 1`,
      })
      .where(and(eq(agents.id, id), eq(agents.draftRevision, body.draftRevision)))
      .returning(),
  );
  if (!updated) throw AppError.conflict("Someone else changed this agent. Reload to see the latest version.", "draft_conflict");
  res.json(updated);
});

agentsRouter.post("/:id/duplicate", async (req, res) => {
  const { orgId, workspaceId } = tenantOf(req);
  const source = await loadAgent(orgId, uuidParam(req, "id"));
  await assertWithinLimit(orgId, "agents");
  const [copy] = await withTenant(orgId, async (tx) => {
    await lockAndAssertWithinLimit(tx, orgId, "agents");
    return tx
      .insert(agents)
      .values({
        orgId,
        workspaceId,
        name: `${source.name} (copy)`.slice(0, 80),
        description: source.description,
        avatarUrl: source.avatarUrl,
        draftConfig: source.draftConfig,
        templateKey: source.templateKey,
        createdBy: req.auth!.user.id,
      })
      .returning();
  });
  res.status(201).json(copy);
});

/** Every tool and knowledge base referenced by the config must exist in this workspace. */
async function assertReferencesExist(orgId: string, toolIds: string[], kbIds: string[]) {
  await withTenant(orgId, async (tx) => {
    if (toolIds.length) {
      const found = await tx.select({ id: tools.id }).from(tools).where(and(inArray(tools.id, toolIds), isNull(tools.deletedAt)));
      if (found.length !== new Set(toolIds).size) throw AppError.badRequest("One of the selected tools no longer exists. Remove it and try again.");
    }
    if (kbIds.length) {
      const found = await tx
        .select({ id: knowledgeBases.id })
        .from(knowledgeBases)
        .where(and(inArray(knowledgeBases.id, kbIds), isNull(knowledgeBases.deletedAt)));
      if (found.length !== new Set(kbIds).size) throw AppError.badRequest("One of the selected knowledge bases no longer exists.");
    }
  });
}

agentsRouter.post("/:id/publish", async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  const { changeNote } = parse(z.object({ changeNote: z.string().max(500).optional() }), req.body ?? {});
  const agent = await loadAgent(orgId, id);
  const config = parseAgentConfig(agent.draftConfig);
  const problems = publishProblems(config);
  if (problems.length) throw AppError.badRequest("This agent isn't ready to publish yet.", problems.map((m) => ({ path: "", message: m })));
  await assertReferencesExist(orgId, config.tools.map((t) => t.toolId), config.knowledge.knowledgeBaseIds);

  const version = await withTenant(orgId, async (tx) => {
    // Lock the agent row so two publishes can't get the same version number.
    await tx.execute(sql`select 1 from agents where id = ${id} for update`);
    const [{ latest } = { latest: 0 }] = await tx
      .select({ latest: max(agentVersions.versionNo) })
      .from(agentVersions)
      .where(eq(agentVersions.agentId, id));
    const [v] = await tx
      .insert(agentVersions)
      .values({
        orgId,
        agentId: id,
        versionNo: (latest ?? 0) + 1,
        config,
        configHash: hashConfig(config),
        changeNote,
        publishedBy: req.auth!.user.id,
      })
      .returning();
    if (config.tools.length) {
      await tx.insert(agentVersionTools).values(
        config.tools.map((t) => ({ orgId, agentVersionId: v!.id, toolId: t.toolId, requiresApproval: t.requiresApproval ?? false, descriptionOverride: t.descriptionOverride })),
      );
    }
    if (config.knowledge.knowledgeBaseIds.length) {
      await tx
        .insert(agentVersionKnowledge)
        .values(config.knowledge.knowledgeBaseIds.map((kb) => ({ orgId, agentVersionId: v!.id, knowledgeBaseId: kb })));
    }
    // Keep the draft hash-identical to what was published.
    await tx.update(agents).set({ publishedVersionId: v!.id, draftConfig: config }).where(eq(agents.id, id));
    await audit(req, { action: "agent.published", targetType: "agent", targetId: id, diff: { versionNo: v!.versionNo } }, tx);
    return v!;
  });
  res.status(201).json(version);
});

agentsRouter.get("/:id/versions", async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  await loadAgent(orgId, id);
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select({
        id: agentVersions.id,
        versionNo: agentVersions.versionNo,
        changeNote: agentVersions.changeNote,
        publishedAt: agentVersions.publishedAt,
        publishedBy: agentVersions.publishedBy,
      })
      .from(agentVersions)
      .where(eq(agentVersions.agentId, id))
      .orderBy(desc(agentVersions.versionNo)),
  );
  res.json({ data: rows });
});

/** Make an older version live again (deployments on "latest" follow immediately). */
agentsRouter.post("/:id/versions/:versionId/activate", async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  const versionId = uuidParam(req, "versionId");
  await loadAgent(orgId, id);
  await withTenant(orgId, async (tx) => {
    const [v] = await tx.select().from(agentVersions).where(and(eq(agentVersions.id, versionId), eq(agentVersions.agentId, id)));
    if (!v) throw AppError.notFound("Version");
    await tx.update(agents).set({ publishedVersionId: v.id }).where(eq(agents.id, id));
    await audit(req, { action: "agent.version_activated", targetType: "agent", targetId: id, diff: { versionNo: v.versionNo } }, tx);
  });
  res.json({ ok: true });
});

/** Copy an older version into the draft for editing (doesn't change what's live). */
agentsRouter.post("/:id/versions/:versionId/restore", async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  const versionId = uuidParam(req, "versionId");
  await loadAgent(orgId, id);
  const updated = await withTenant(orgId, async (tx) => {
    const [v] = await tx.select().from(agentVersions).where(and(eq(agentVersions.id, versionId), eq(agentVersions.agentId, id)));
    if (!v) throw AppError.notFound("Version");
    const [a] = await tx
      .update(agents)
      .set({ draftConfig: v.config, draftRevision: sql`${agents.draftRevision} + 1` })
      .where(eq(agents.id, id))
      .returning();
    return a;
  });
  res.json(updated);
});

agentsRouter.post("/:id/status", async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  const { status } = parse(z.object({ status: z.enum(["active", "disabled"]) }), req.body);
  const agent = await loadAgent(orgId, id);
  if (agent.disabledByAdminAt && status === "active") {
    throw AppError.forbidden("This agent was disabled by the platform team. Contact support.", "disabled_by_admin");
  }
  await withTenant(orgId, async (tx) => {
    await tx.update(agents).set({ status }).where(eq(agents.id, id));
    await audit(req, { action: `agent.${status === "active" ? "enabled" : "disabled"}`, targetType: "agent", targetId: id }, tx);
  });
  res.json({ ok: true });
});

agentsRouter.delete("/:id", requireRole("admin"), async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  await loadAgent(orgId, id);
  await withTenant(orgId, async (tx) => {
    const now = new Date();
    await tx.update(agents).set({ deletedAt: now, status: "disabled" }).where(eq(agents.id, id));
    await tx.update(deployments).set({ deletedAt: now, status: "paused" }).where(eq(deployments.agentId, id));
    await audit(req, { action: "agent.deleted", targetType: "agent", targetId: id }, tx);
  });
  res.status(204).end();
});

const testSchema = z.object({
  message: z.string().min(1).max(8000),
  conversationId: z.uuid().optional(),
  version: z.enum(["draft", "published"]).default("draft"),
});

/** Playground: streams the run with full trace events. */
agentsRouter.post("/:id/test", perUserLimit("agent-test", 30), async (req, res) => {
  const { orgId, workspaceId } = tenantOf(req);
  const id = uuidParam(req, "id");
  const body = parse(testSchema, req.body);
  const agent = await loadAgent(orgId, id);

  let config = parseAgentConfig(agent.draftConfig);
  let versionId: string | null = null;
  if (body.version === "published") {
    if (!agent.publishedVersionId) throw AppError.badRequest("This agent hasn't been published yet.");
    const [v] = await withTenant(orgId, (tx) => tx.select().from(agentVersions).where(eq(agentVersions.id, agent.publishedVersionId!)));
    config = v!.config;
    versionId = v!.id;
  }

  const prepared = await prepareRun({
    orgId,
    workspaceId,
    agentId: id,
    agentName: agent.name,
    config,
    agentVersionId: versionId,
    input: body.message,
    conversationId: body.conversationId,
    source: "playground",
    userId: req.auth!.user.id,
  });
  const sse = openSse(req, res);
  for await (const ev of streamRun(prepared)) sse.send(ev);
  sse.end();
});

agentsRouter.get("/:id/analytics", async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
  const since = new Date(Date.now() - days * 86_400_000);
  const [row] = await withTenant(orgId, (tx) =>
    tx
      .select({
        runs: count(),
        succeeded: sql<number>`count(*) filter (where ${executions.status} = 'succeeded')::int`,
        failed: sql<number>`count(*) filter (where ${executions.status} = 'failed')::int`,
        p50LatencyMs: sql<number | null>`percentile_cont(0.5) within group (order by ${executions.latencyMs})`,
        p95LatencyMs: sql<number | null>`percentile_cont(0.95) within group (order by ${executions.latencyMs})`,
        inputTokens: sql<number>`coalesce(sum(${executions.inputTokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${executions.outputTokens}), 0)::int`,
        costUsd: sql<string>`coalesce(sum(${executions.costUsd}), 0)::text`,
        conversations: sql<number>`count(distinct ${executions.conversationId})::int`,
      })
      .from(executions)
      .where(and(eq(executions.agentId, id), gte(executions.startedAt, since), sql`${executions.source} <> 'playground'`)),
  );
  const daily = await withTenant(orgId, (tx) =>
    tx
      .select({
        day: sql<string>`to_char(date_trunc('day', ${executions.startedAt}), 'YYYY-MM-DD')`,
        runs: sql<number>`count(*)::int`,
        failed: sql<number>`count(*) filter (where ${executions.status} = 'failed')::int`,
        costUsd: sql<number>`coalesce(sum(${executions.costUsd}), 0)::float`,
      })
      .from(executions)
      .where(and(eq(executions.agentId, id), gte(executions.startedAt, since), sql`${executions.source} <> 'playground'`))
      .groupBy(sql`1`)
      .orderBy(sql`1`),
  );
  res.json({ days, ...row, daily });
});
