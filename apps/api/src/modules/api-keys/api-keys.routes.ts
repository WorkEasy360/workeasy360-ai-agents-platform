import { Router } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { withTenant } from "@we360/db";
import { apiKeys } from "@we360/db/schema";
import { AppError } from "../../lib/errors";
import { audit, parse, tenantOf, uuidParam } from "../../lib/http";
import { requireRole, requireSession, requireTenant } from "../../middleware/auth";
import { generateApiKey } from "./api-keys";
import { getWebhookSecret, rotateWebhookSecret } from "../runs/webhooks";

export const apiKeysRouter = Router();
apiKeysRouter.use(requireSession, requireTenant, requireRole("admin"));

apiKeysRouter.get("/", async (req, res) => {
  const { orgId, workspaceId } = tenantOf(req);
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, lastUsedAt: apiKeys.lastUsedAt, expiresAt: apiKeys.expiresAt, createdAt: apiKeys.createdAt })
      .from(apiKeys)
      .where(and(eq(apiKeys.workspaceId, workspaceId), isNull(apiKeys.revokedAt)))
      .orderBy(desc(apiKeys.createdAt)),
  );
  res.json({ data: rows });
});

apiKeysRouter.post("/", async (req, res) => {
  const { orgId, workspaceId } = tenantOf(req);
  const { name, expiresInDays } = parse(
    z.object({ name: z.string().trim().min(1).max(80), expiresInDays: z.number().int().min(1).max(730).optional() }),
    req.body,
  );
  const key = generateApiKey();
  const [row] = await withTenant(orgId, async (tx) => {
    const inserted = await tx
      .insert(apiKeys)
      .values({
        orgId,
        workspaceId,
        name,
        prefix: key.prefix,
        keyHash: key.hash,
        scopes: ["runs:write"],
        expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000) : null,
        createdBy: req.auth!.user.id,
      })
      .returning({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix, createdAt: apiKeys.createdAt, expiresAt: apiKeys.expiresAt });
    await audit(req, { action: "api_key.created", targetType: "api_key", targetId: inserted[0]!.id }, tx);
    return inserted;
  });
  // The only time the secret is ever returned.
  res.status(201).json({ ...row, secret: key.secret });
});

apiKeysRouter.delete("/:id", async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  await withTenant(orgId, async (tx) => {
    const [row] = await tx.update(apiKeys).set({ revokedAt: new Date() }).where(and(eq(apiKeys.id, id), isNull(apiKeys.revokedAt))).returning({ id: apiKeys.id });
    if (!row) throw AppError.notFound("API key");
    await audit(req, { action: "api_key.revoked", targetType: "api_key", targetId: id }, tx);
  });
  res.status(204).end();
});

/** Signing secret for async-run callbacks (shown to admins so they can verify signatures). */
apiKeysRouter.get("/webhook-secret", async (req, res) => {
  const secret = await getWebhookSecret(tenantOf(req).orgId, req.auth!.user.id);
  // Every reveal is recorded, so a leaked secret can be traced to who viewed it.
  await audit(req, { action: "webhook_secret.revealed", targetType: "organization", targetId: tenantOf(req).orgId });
  res.setHeader("cache-control", "no-store");
  res.json({ secret });
});

apiKeysRouter.post("/webhook-secret/rotate", async (req, res) => {
  const secret = await rotateWebhookSecret(tenantOf(req).orgId, req.auth!.user.id);
  await audit(req, { action: "webhook_secret.rotated", targetType: "organization", targetId: tenantOf(req).orgId });
  res.json({ secret });
});
