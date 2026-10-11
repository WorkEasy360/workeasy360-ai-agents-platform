import { randomBytes } from "node:crypto";
import { Router } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { withTenant } from "@we360/db";
import { agentVersions, agents, deployments } from "@we360/db/schema";
import { AppError } from "../../lib/errors";
import { audit, parse, tenantOf, uuidParam } from "../../lib/http";
import { requireSession, requireTenant } from "../../middleware/auth";
import { getOrgLimits } from "../plans/plan-limits";

/** Deployments of one agent: /api/v1/agents/:agentId/deployments */
export const deploymentsRouter = Router({ mergeParams: true });
deploymentsRouter.use(requireSession, requireTenant);

const originSchema = z
  .string()
  .trim()
  .regex(/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i, "Use an origin like https://www.example.com (no path)");

const configSchema = z.object({
  title: z.string().max(80).optional(),
  allowedOrigins: z.array(originSchema).max(20).optional(),
  // Shown under the chat input with the "processed by AI" notice.
  privacyPolicyUrl: z.url({ protocol: /^https?$/ }).max(500).optional(),
  theme: z
    .object({
      primaryColor: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
      position: z.enum(["right", "left"]).optional(),
    })
    .optional(),
});

const createSchema = z.object({
  channel: z.enum(["hosted_page", "web_widget", "api"]),
  versionPolicy: z.enum(["latest", "pinned"]).default("latest"),
  pinnedVersionId: z.uuid().nullable().optional(),
  config: configSchema.default({}),
});

async function loadAgent(orgId: string, agentId: string) {
  const [agent] = await withTenant(orgId, (tx) => tx.select().from(agents).where(and(eq(agents.id, agentId), isNull(agents.deletedAt))));
  if (!agent) throw AppError.notFound("Agent");
  return agent;
}

async function assertPinnedVersion(orgId: string, agentId: string, versionId: string | null | undefined) {
  if (!versionId) return;
  const [v] = await withTenant(orgId, (tx) =>
    tx.select({ id: agentVersions.id }).from(agentVersions).where(and(eq(agentVersions.id, versionId), eq(agentVersions.agentId, agentId))),
  );
  if (!v) throw AppError.badRequest("That version doesn't belong to this agent.");
}

deploymentsRouter.get("/", async (req, res) => {
  const { orgId } = tenantOf(req);
  const agentId = uuidParam(req, "agentId");
  await loadAgent(orgId, agentId);
  const rows = await withTenant(orgId, (tx) =>
    tx.select().from(deployments).where(and(eq(deployments.agentId, agentId), isNull(deployments.deletedAt))).orderBy(desc(deployments.createdAt)),
  );
  res.json({ data: rows });
});

deploymentsRouter.post("/", async (req, res) => {
  const { orgId, workspaceId } = tenantOf(req);
  const agentId = uuidParam(req, "agentId");
  const body = parse(createSchema, req.body);
  await loadAgent(orgId, agentId);

  const limits = await getOrgLimits(orgId);
  if (!limits.channels.includes(body.channel)) {
    throw AppError.forbidden("This channel isn't included in your plan. Upgrade to use it.", "plan_limit_reached");
  }
  if (body.versionPolicy === "pinned") {
    if (!body.pinnedVersionId) throw AppError.badRequest("Choose the version to pin.");
    await assertPinnedVersion(orgId, agentId, body.pinnedVersionId);
  }

  const [row] = await withTenant(orgId, async (tx) => {
    const existing = await tx
      .select({ id: deployments.id })
      .from(deployments)
      .where(and(eq(deployments.agentId, agentId), eq(deployments.channel, body.channel), isNull(deployments.deletedAt)));
    if (existing.length) throw AppError.conflict("This agent already has that channel. Edit the existing one instead.");
    const inserted = await tx
      .insert(deployments)
      .values({
        orgId,
        workspaceId,
        agentId,
        channel: body.channel,
        versionPolicy: body.versionPolicy,
        pinnedVersionId: body.versionPolicy === "pinned" ? body.pinnedVersionId : null,
        publicKey: body.channel === "api" ? null : `pk_${randomBytes(18).toString("base64url")}`,
        config: body.config,
        createdBy: req.auth!.user.id,
      })
      .returning();
    await audit(req, { action: "deployment.created", targetType: "deployment", targetId: inserted[0]!.id, diff: { channel: body.channel } }, tx);
    return inserted;
  });
  res.status(201).json(row);
});

deploymentsRouter.patch("/:id", async (req, res) => {
  const { orgId } = tenantOf(req);
  const agentId = uuidParam(req, "agentId");
  const id = uuidParam(req, "id");
  const body = parse(
    z.object({
      status: z.enum(["active", "paused"]).optional(),
      versionPolicy: z.enum(["latest", "pinned"]).optional(),
      pinnedVersionId: z.uuid().nullable().optional(),
      config: configSchema.optional(),
    }),
    req.body,
  );
  await assertPinnedVersion(orgId, agentId, body.pinnedVersionId);
  const [row] = await withTenant(orgId, async (tx) => {
    const [current] = await tx.select().from(deployments).where(and(eq(deployments.id, id), eq(deployments.agentId, agentId), isNull(deployments.deletedAt)));
    if (!current) throw AppError.notFound("Deployment");
    if (current.status === "disabled_by_admin") throw AppError.forbidden("This deployment was disabled by the platform team.", "disabled_by_admin");
    const policy = body.versionPolicy ?? current.versionPolicy;
    const pinned = policy === "pinned" ? (body.pinnedVersionId ?? current.pinnedVersionId) : null;
    if (policy === "pinned" && !pinned) throw AppError.badRequest("Choose the version to pin.");
    const updated = await tx
      .update(deployments)
      .set({ status: body.status, versionPolicy: policy, pinnedVersionId: pinned, config: body.config ?? current.config })
      .where(eq(deployments.id, id))
      .returning();
    await audit(req, { action: "deployment.updated", targetType: "deployment", targetId: id, diff: body }, tx);
    return updated;
  });
  res.json(row);
});

deploymentsRouter.delete("/:id", async (req, res) => {
  const { orgId } = tenantOf(req);
  const agentId = uuidParam(req, "agentId");
  const id = uuidParam(req, "id");
  await withTenant(orgId, async (tx) => {
    const [row] = await tx
      .update(deployments)
      .set({ deletedAt: new Date(), status: "paused" })
      .where(and(eq(deployments.id, id), eq(deployments.agentId, agentId), isNull(deployments.deletedAt)))
      .returning({ id: deployments.id });
    if (!row) throw AppError.notFound("Deployment");
    await audit(req, { action: "deployment.deleted", targetType: "deployment", targetId: id }, tx);
  });
  res.status(204).end();
});
