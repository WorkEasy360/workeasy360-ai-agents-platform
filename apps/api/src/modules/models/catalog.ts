import { and, asc, eq } from "drizzle-orm";
import { appDb } from "@we360/db";
import { aiModels } from "@we360/db/schema";

export type AiModel = typeof aiModels.$inferSelect;
export type ModelTier = "fast" | "balanced" | "premium";

export async function listChatModels(): Promise<AiModel[]> {
  return appDb()
    .select()
    .from(aiModels)
    .where(and(eq(aiModels.isEnabled, true), eq(aiModels.kind, "chat")))
    .orderBy(asc(aiModels.provider), asc(aiModels.displayName));
}

export async function getModel(id: string): Promise<AiModel | undefined> {
  const [row] = await appDb().select().from(aiModels).where(eq(aiModels.id, id)).limit(1);
  return row;
}

export async function getDefaultChatModel(): Promise<AiModel | undefined> {
  const [row] = await appDb()
    .select()
    .from(aiModels)
    .where(and(eq(aiModels.isDefault, true), eq(aiModels.kind, "chat"), eq(aiModels.isEnabled, true)))
    .limit(1);
  return row;
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
  return appDb()
    .select()
    .from(aiModels)
    .where(and(eq(aiModels.kind, "embedding"), eq(aiModels.isEnabled, true)));
}

/** USD cost for a call, from catalog prices per million tokens. */
export function costUsd(model: Pick<AiModel, "inputPricePerMtokUsd" | "outputPricePerMtokUsd">, inTok: number, outTok: number) {
  return (inTok * Number(model.inputPricePerMtokUsd) + outTok * Number(model.outputPricePerMtokUsd)) / 1_000_000;
}
