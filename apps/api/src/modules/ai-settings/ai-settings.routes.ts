import { Router } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { withTenant } from "@we360/db";
import { credentials, orgAiSettings } from "@we360/db/schema";
import { encryptSecret, last4 } from "../../lib/crypto";
import { AppError } from "../../lib/errors";
import { audit, parse, tenantOf } from "../../lib/http";
import { perUserLimit } from "../../lib/rate-limit";
import { requireRole, requireSession, requireTenant } from "../../middleware/auth";
import { type Provider, verifyProviderKey } from "../models/gateway";

/**
 * Per-provider choice between platform credits and the org's own key (BYOK).
 * Keys are validated against the provider before saving and are never returned.
 */
export const aiSettingsRouter = Router();
aiSettingsRouter.use(requireSession, requireTenant);

const PROVIDERS: Provider[] = ["openai", "anthropic", "google"];
const providerSchema = z.enum(["openai", "anthropic", "google"]);

aiSettingsRouter.get("/", async (req, res) => {
  const { orgId } = tenantOf(req);
  const { settings, keys } = await withTenant(orgId, async (tx) => {
    const [settings] = await tx.select().from(orgAiSettings).limit(1);
    const keys = await tx
      .select({ integrationKey: credentials.integrationKey, last4: credentials.last4, updatedAt: credentials.updatedAt, status: credentials.status })
      .from(credentials)
      .where(isNull(credentials.deletedAt));
    return { settings, keys };
  });
  res.json({
    providers: PROVIDERS.map((p) => {
      const key = keys.find((k) => k.integrationKey === `llm.${p}`);
      return {
        provider: p,
        mode: settings?.providers[p]?.mode ?? "platform",
        key: key ? { last4: key.last4, updatedAt: key.updatedAt, status: key.status } : null,
      };
    }),
  });
});

aiSettingsRouter.put("/:provider/key", requireRole("admin"), perUserLimit("ai-key-check", 10), async (req, res) => {
  const { orgId } = tenantOf(req);
  const provider = parse(providerSchema, req.params.provider);
  const { apiKey } = parse(z.object({ apiKey: z.string().trim().min(10).max(500) }), req.body);
  if (!(await verifyProviderKey(provider, apiKey).catch(() => false))) {
    throw AppError.badRequest(`${provider} rejected this key. Check it and try again.`);
  }
  const enc = await encryptSecret(apiKey);
  await withTenant(orgId, async (tx) => {
    const integrationKey = `llm.${provider}`;
    const [existing] = await tx
      .select({ id: credentials.id })
      .from(credentials)
      .where(and(eq(credentials.integrationKey, integrationKey), isNull(credentials.deletedAt)));
    const values = { ...enc, last4: last4(apiKey), status: "active", lastVerifiedAt: new Date() };
    if (existing) await tx.update(credentials).set(values).where(eq(credentials.id, existing.id));
    else {
      await tx.insert(credentials).values({
        orgId,
        integrationKey,
        name: `${provider} API key`,
        authType: "bearer",
        createdBy: req.auth!.user.id,
        ...values,
      });
    }
    await audit(req, { action: "ai_settings.key_saved", targetType: "provider", targetId: provider }, tx);
  });
  res.json({ ok: true, last4: last4(apiKey) });
});

aiSettingsRouter.delete("/:provider/key", requireRole("admin"), async (req, res) => {
  const { orgId } = tenantOf(req);
  const provider = parse(providerSchema, req.params.provider);
  await withTenant(orgId, async (tx) => {
    // Hard delete: the encrypted key is not kept once removed.
    await tx.delete(credentials).where(eq(credentials.integrationKey, `llm.${provider}`));
    // Without a key, BYOK can't work: fall back to platform credits.
    const [settings] = await tx.select().from(orgAiSettings).limit(1);
    if (settings) {
      await tx
        .update(orgAiSettings)
        .set({ providers: { ...settings.providers, [provider]: { mode: "platform" } } })
        .where(eq(orgAiSettings.orgId, orgId));
    }
    await audit(req, { action: "ai_settings.key_removed", targetType: "provider", targetId: provider }, tx);
  });
  res.status(204).end();
});

aiSettingsRouter.put("/:provider/mode", requireRole("admin"), async (req, res) => {
  const { orgId } = tenantOf(req);
  const provider = parse(providerSchema, req.params.provider);
  const { mode } = parse(z.object({ mode: z.enum(["platform", "byok"]) }), req.body);
  await withTenant(orgId, async (tx) => {
    if (mode === "byok") {
      const [key] = await tx
        .select({ id: credentials.id })
        .from(credentials)
        .where(and(eq(credentials.integrationKey, `llm.${provider}`), isNull(credentials.deletedAt)));
      if (!key) throw AppError.badRequest(`Add your ${provider} key first.`);
    }
    const [settings] = await tx.select().from(orgAiSettings).limit(1);
    const providers = { ...(settings?.providers ?? {}), [provider]: { mode } };
    if (settings) await tx.update(orgAiSettings).set({ providers }).where(eq(orgAiSettings.orgId, orgId));
    else await tx.insert(orgAiSettings).values({ orgId, providers });
    await audit(req, { action: "ai_settings.mode_changed", targetType: "provider", targetId: provider, diff: { mode } }, tx);
  });
  res.json({ ok: true });
});
