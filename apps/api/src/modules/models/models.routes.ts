import { Router } from "express";
import { requireSession, requireTenant } from "../../middleware/auth";
import { tenantOf } from "../../lib/http";
import { getOrgLimits } from "../plans/plan-limits";
import { listChatModels } from "./catalog";
import { type Provider, usableProviders } from "./gateway";

export const modelsRouter = Router();
modelsRouter.use(requireSession, requireTenant);

/** Chat models with whether the org's plan allows each one and whether it has a key for the provider. */
modelsRouter.get("/", async (req, res) => {
  const { orgId } = tenantOf(req);
  const [limits, models, usable] = await Promise.all([getOrgLimits(orgId), listChatModels(), usableProviders(orgId)]);
  res.json({
    data: models.map((m) => ({
      id: m.id,
      provider: m.provider,
      modelKey: m.modelKey,
      displayName: m.displayName,
      tier: m.tier,
      contextWindow: m.contextWindow,
      supportsTemperature: m.capabilities.temperature !== false,
      isDefault: m.isDefault,
      allowedOnPlan: limits.modelTiers.includes(m.tier as never),
      hasKey: usable.has(m.provider as Provider),
    })),
  });
});
