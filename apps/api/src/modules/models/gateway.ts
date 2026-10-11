import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { embedMany } from "ai";
import { and, eq, isNull } from "drizzle-orm";
import { withTenant } from "@we360/db";
import { credentials, orgAiSettings } from "@we360/db/schema";
import { decryptSecret } from "../../lib/crypto";
import { AppError } from "../../lib/errors";
import { type AiModel, getEmbeddingModels } from "./catalog";
import { createMockModel, mockEmbedding } from "./mock-model";

/**
 * The model layer. Everything that calls an LLM goes through here, never through a provider
 * SDK directly. It picks the key (platform or the org's own), builds the provider model,
 * and reports which billing source applies.
 */

export type Provider = "openai" | "anthropic" | "google";
export type BillingSource = "platform" | "byok";

const PLATFORM_KEY_ENV: Record<Provider, string> = {
  openai: "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  google: "GOOGLE_GENERATIVE_AI_API_KEY",
};

export const mockEnabled = () => process.env.MOCK_LLM === "true" && process.env.NODE_ENV !== "production";

interface ResolvedKey {
  apiKey: string;
  billingSource: BillingSource;
}

export async function resolveProviderKey(orgId: string, provider: Provider): Promise<ResolvedKey> {
  const byok = await withTenant(orgId, async (tx) => {
    const [settings] = await tx.select().from(orgAiSettings).limit(1);
    const pref = settings?.providers[provider];
    if (pref?.mode !== "byok") return undefined;
    const [cred] = await tx
      .select()
      .from(credentials)
      .where(and(eq(credentials.integrationKey, `llm.${provider}`), isNull(credentials.deletedAt)))
      .limit(1);
    if (!cred) {
      throw new AppError(400, "byok_key_missing", `Your organization uses its own ${provider} key, but none is saved.`);
    }
    return cred;
  });
  if (byok) return { apiKey: await decryptSecret(byok), billingSource: "byok" };

  const apiKey = process.env[PLATFORM_KEY_ENV[provider]];
  if (!apiKey) {
    throw new AppError(
      503,
      "provider_unavailable",
      `No ${PROVIDER_LABEL[provider]} key is available. Add your own key in Settings → AI models, or choose a model from a provider you have a key for.`,
    );
  }
  return { apiKey, billingSource: "platform" };
}

export const PROVIDER_LABEL: Record<Provider, string> = { openai: "OpenAI", anthropic: "Anthropic", google: "Google Gemini" };
const ALL_PROVIDERS: Provider[] = ["openai", "anthropic", "google"];

/** Providers this org can call right now: its own key (BYOK mode) or a platform key in the environment. */
export async function usableProviders(orgId: string): Promise<Set<Provider>> {
  if (mockEnabled()) return new Set(ALL_PROVIDERS);
  const { settings, keys } = await withTenant(orgId, async (tx) => {
    const [settings] = await tx.select().from(orgAiSettings).limit(1);
    const keys = await tx
      .select({ integrationKey: credentials.integrationKey })
      .from(credentials)
      .where(isNull(credentials.deletedAt));
    return { settings, keys };
  });
  const usable = new Set<Provider>();
  for (const p of ALL_PROVIDERS) {
    const byok = settings?.providers[p]?.mode === "byok";
    if (byok ? keys.some((k) => k.integrationKey === `llm.${p}`) : Boolean(process.env[PLATFORM_KEY_ENV[p]])) usable.add(p);
  }
  return usable;
}

export function buildLanguageModel(provider: Provider, modelKey: string, apiKey: string): LanguageModelV4 {
  switch (provider) {
    case "openai":
      return createOpenAI({ apiKey })(modelKey) as LanguageModelV4;
    case "anthropic":
      return createAnthropic({ apiKey })(modelKey) as LanguageModelV4;
    case "google":
      return createGoogle({ apiKey })(modelKey) as LanguageModelV4;
  }
}

export async function resolveChatModel(
  orgId: string,
  model: AiModel,
): Promise<{ languageModel: LanguageModelV4; billingSource: BillingSource }> {
  if (mockEnabled()) return { languageModel: createMockModel(model.modelKey), billingSource: "platform" };
  const key = await resolveProviderKey(orgId, model.provider as Provider);
  return { languageModel: buildLanguageModel(model.provider as Provider, model.modelKey, key.apiKey), billingSource: key.billingSource };
}

export interface EmbeddingResult {
  embeddings: number[][];
  tokens: number;
  model: AiModel | undefined;
  billingSource: BillingSource;
  /** "provider:modelKey" actually used ("mock:mock" in mock mode). Stored on the knowledge base. */
  modelRef: string;
}

/** Stored vectors are 1536-dimensional; providers with configurable size are asked for exactly that. */
const EMBEDDING_DIMENSIONS = 1536;
const EMBEDDING_PROVIDER_ORDER: Provider[] = ["openai", "google"];

export const embeddingRef = (m: Pick<AiModel, "provider" | "modelKey">) => `${m.provider}:${m.modelKey}`;

/**
 * Picks the embedding model: the preferred one (what a knowledge base was built with) if the org
 * can still use it, otherwise the first usable provider (OpenAI, then Google Gemini).
 */
export async function resolveEmbeddingModel(orgId: string, preferredRef?: string): Promise<AiModel> {
  const models = await getEmbeddingModels();
  const usable = await usableProviders(orgId);
  const candidates = models.filter((m) => usable.has(m.provider as Provider));
  const chosen =
    candidates.find((m) => embeddingRef(m) === preferredRef) ??
    EMBEDDING_PROVIDER_ORDER.map((p) => candidates.find((m) => m.provider === p)).find(Boolean);
  if (!chosen) {
    throw new AppError(
      503,
      "no_embedding_provider",
      "Knowledge search needs an OpenAI or Google Gemini key. Add one in Settings → AI models.",
    );
  }
  return chosen;
}

/** Embeds texts for storage ("document") or search ("query"). */
export async function embedTexts(
  orgId: string,
  texts: string[],
  opts: { preferredRef?: string; purpose?: "document" | "query" } = {},
): Promise<EmbeddingResult> {
  if (mockEnabled()) {
    return {
      embeddings: texts.map((t) => mockEmbedding(t)),
      tokens: texts.reduce((s, t) => s + Math.ceil(t.length / 4), 0),
      model: undefined,
      billingSource: "platform",
      modelRef: "mock:mock",
    };
  }
  const model = await resolveEmbeddingModel(orgId, opts.preferredRef);
  const provider = model.provider as Provider;
  const key = await resolveProviderKey(orgId, provider);
  const embeddingModel =
    provider === "google"
      ? createGoogle({ apiKey: key.apiKey }).embeddingModel(model.modelKey)
      : createOpenAI({ apiKey: key.apiKey }).embeddingModel(model.modelKey);
  const out = await embedMany({
    model: embeddingModel,
    values: texts,
    maxParallelCalls: 2,
    // Search queries are on the chat path; document batches run in the worker.
    abortSignal: AbortSignal.timeout(opts.purpose === "query" ? 15_000 : 60_000),
    providerOptions: {
      google: { outputDimensionality: EMBEDDING_DIMENSIONS, taskType: opts.purpose === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT" },
    },
  });
  return {
    embeddings: out.embeddings,
    // Google doesn't report embedding tokens; estimate so usage and cost are still recorded.
    tokens: out.usage.tokens || texts.reduce((s, t) => s + Math.ceil(t.length / 4), 0),
    model,
    billingSource: key.billingSource,
    modelRef: embeddingRef(model),
  };
}

/** Checks a key against the provider's free "list models" endpoint. No tokens are spent. */
export async function verifyProviderKey(provider: Provider, apiKey: string): Promise<boolean> {
  const timeout = AbortSignal.timeout(10_000);
  const res =
    provider === "openai"
      ? await fetch("https://api.openai.com/v1/models", { headers: { authorization: `Bearer ${apiKey}` }, signal: timeout })
      : provider === "anthropic"
        ? await fetch("https://api.anthropic.com/v1/models", {
            headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
            signal: timeout,
          })
        : await fetch("https://generativelanguage.googleapis.com/v1beta/models", {
            headers: { "x-goog-api-key": apiKey },
            signal: timeout,
          });
  return res.ok;
}
