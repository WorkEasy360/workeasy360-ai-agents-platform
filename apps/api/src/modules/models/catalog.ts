import { asc } from "drizzle-orm";
import { appDb } from "@we360/db";
import { aiModels } from "@we360/db/schema";
import { ttlCache } from "../../lib/ttl-cache";

export type AiModel = typeof aiModels.$inferSelect;
export type ModelTier = "fast" | "balanced" | "premium";

// The catalog is small and global: read it whole, at most once a minute per process (the database is far away).
const catalog = ttlCache<"all", AiModel[]>(60_000);
const allModels = () => catalog.get("all", () => appDb().select().from(aiModels).orderBy(asc(aiModels.provider), asc(aiModels.displayName)));

/** Call after changing ai_models (admin catalog edits). */
export function clearModelCache(): void {
  catalog.clear();
}

/** Every catalog row, enabled or not (cached). */
export function allCatalogModels(): Promise<AiModel[]> {
  return allModels();
}

export async function listChatModels(): Promise<AiModel[]> {
  return (await allModels()).filter((m) => m.isEnabled && m.kind === "chat");
}

export async function getModel(id: string): Promise<AiModel | undefined> {
  return (await allModels()).find((m) => m.id === id);
}

export async function getDefaultChatModel(): Promise<AiModel | undefined> {
  return (await allModels()).find((m) => m.isDefault && m.kind === "chat" && m.isEnabled);
}

/**
 * Default model for a new agent: the catalog default if the plan allows it and the org has a key
 * for its provider, otherwise the best allowed tier among usable providers.
 */
export async function getDefaultModelForTiers(tiers: ModelTier[], usableProviders?: Set<string>): Promise<AiModel | undefined> {
  const models = await listChatModels();
  const inPlan = models.filter((m) => tiers.includes(m.tier as ModelTier));
  const usable = usableProviders ? inPlan.filter((m) => usableProviders.has(m.provider)) : inPlan;
  const allowed = usable.length ? usable : inPlan;
  const order: ModelTier[] = ["balanced", "fast", "premium"];
  return (
    allowed.find((m) => m.isDefault) ??
    order.map((t) => allowed.find((m) => m.tier === t)).find(Boolean)
  );
}

export async function getEmbeddingModels(): Promise<AiModel[]> {
  return (await allModels()).filter((m) => m.kind === "embedding" && m.isEnabled);
}

/** USD cost for a call, from catalog prices per million tokens. */
export function costUsd(model: Pick<AiModel, "inputPricePerMtokUsd" | "outputPricePerMtokUsd">, inTok: number, outTok: number) {
  return (inTok * Number(model.inputPricePerMtokUsd) + outTok * Number(model.outputPricePerMtokUsd)) / 1_000_000;
}
