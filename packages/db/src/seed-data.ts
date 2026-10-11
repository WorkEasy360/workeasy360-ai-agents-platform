/**
 * Global catalog data: plans, AI models and feature flags. Insert-only, so re-running never overwrites admin edits.
 * Plan limits are placeholders until the product owner confirms them (blueprint §0.5).
 * Used by the local CLI (src/seed.ts) and by the API image (dist/scripts/seed.js).
 */
import { sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { aiModels, featureFlags, plans, type PlanLimits } from "./schema/platform";

const planRows: Array<{ key: string; name: string; sortOrder: number; isPublic: boolean; limits: PlanLimits }> = [
  {
    key: "free",
    name: "Free",
    sortOrder: 0,
    isPublic: true,
    limits: {
      agents: 1,
      messagesPerMonth: 100,
      platformCreditsUsdPerMonth: 0.5,
      knowledgeStorageMb: 10,
      members: 1,
      modelTiers: ["fast"],
      channels: ["hosted_page", "web_widget"],
      removeBranding: false,
      logRetentionDays: 7,
    },
  },
  {
    key: "starter",
    name: "Starter",
    sortOrder: 1,
    isPublic: true,
    limits: {
      agents: 3,
      messagesPerMonth: 2000,
      platformCreditsUsdPerMonth: 10,
      knowledgeStorageMb: 100,
      members: 3,
      modelTiers: ["fast", "balanced"],
      channels: ["hosted_page", "web_widget", "api"],
      removeBranding: false,
      logRetentionDays: 30,
    },
  },
  {
    key: "professional",
    name: "Professional",
    sortOrder: 2,
    isPublic: true,
    limits: {
      agents: 10,
      messagesPerMonth: 10000,
      platformCreditsUsdPerMonth: 50,
      knowledgeStorageMb: 1024,
      members: 10,
      modelTiers: ["fast", "balanced", "premium"],
      channels: ["hosted_page", "web_widget", "api"],
      removeBranding: true,
      logRetentionDays: 60,
    },
  },
  {
    key: "business",
    name: "Business",
    sortOrder: 3,
    isPublic: true,
    limits: {
      agents: 25,
      messagesPerMonth: 50000,
      platformCreditsUsdPerMonth: 200,
      knowledgeStorageMb: 5120,
      members: 25,
      modelTiers: ["fast", "balanced", "premium"],
      channels: ["hosted_page", "web_widget", "api"],
      removeBranding: true,
      logRetentionDays: 90,
    },
  },
  {
    key: "enterprise",
    name: "Enterprise",
    sortOrder: 4,
    isPublic: false, // custom limits via organization.plan_overrides
    limits: {
      agents: null,
      messagesPerMonth: null,
      platformCreditsUsdPerMonth: null,
      knowledgeStorageMb: null,
      members: null,
      modelTiers: ["fast", "balanced", "premium"],
      channels: ["hosted_page", "web_widget", "api"],
      removeBranding: true,
      logRetentionDays: 180,
    },
  },
];

type ModelSeed = typeof aiModels.$inferInsert;

// Anthropic prices verified 2026-09-25. OpenAI and Google prices: VERIFY BEFORE LAUNCH
// against the providers' pricing pages; super admins can edit them in the Models page.
const modelRows: ModelSeed[] = [
  {
    provider: "anthropic",
    modelKey: "claude-haiku-4-5",
    displayName: "Claude Haiku 4.5",
    tier: "fast",
    contextWindow: 200_000,
    inputPricePerMtokUsd: "1",
    outputPricePerMtokUsd: "5",
    capabilities: { tools: true, vision: true, temperature: true },
  },
  {
    provider: "anthropic",
    modelKey: "claude-sonnet-5-5",
    displayName: "Claude Sonnet 5.5",
    tier: "balanced",
    contextWindow: 1_000_000,
    inputPricePerMtokUsd: "2",
    outputPricePerMtokUsd: "10",
    capabilities: { tools: true, vision: true, temperature: false },
    isDefault: true,
  },
  {
    provider: "anthropic",
    modelKey: "claude-opus-5-5",
    displayName: "Claude Opus 5.5",
    tier: "premium",
    contextWindow: 1_000_000,
    inputPricePerMtokUsd: "4",
    outputPricePerMtokUsd: "20",
    capabilities: { tools: true, vision: true, temperature: false },
  },
  {
    provider: "openai",
    modelKey: "gpt-5-mini",
    displayName: "GPT-5 mini",
    tier: "fast",
    contextWindow: 400_000,
    inputPricePerMtokUsd: "0.25",
    outputPricePerMtokUsd: "2",
    capabilities: { tools: true, vision: true, temperature: false },
  },
  {
    provider: "openai",
    modelKey: "gpt-5",
    displayName: "GPT-5",
    tier: "premium",
    contextWindow: 400_000,
    inputPricePerMtokUsd: "1.25",
    outputPricePerMtokUsd: "10",
    capabilities: { tools: true, vision: true, temperature: false },
  },
  {
    provider: "google",
    modelKey: "gemini-2.5-flash",
    displayName: "Gemini 2.5 Flash",
    tier: "fast",
    contextWindow: 1_000_000,
    inputPricePerMtokUsd: "0.30",
    outputPricePerMtokUsd: "2.50",
    capabilities: { tools: true, vision: true, temperature: true },
  },
  {
    provider: "google",
    modelKey: "gemini-2.5-pro",
    displayName: "Gemini 2.5 Pro",
    tier: "balanced",
    contextWindow: 1_000_000,
    inputPricePerMtokUsd: "1.25",
    outputPricePerMtokUsd: "10",
    capabilities: { tools: true, vision: true, temperature: true },
  },
  {
    provider: "openai",
    modelKey: "text-embedding-3-small",
    displayName: "OpenAI Embedding 3 Small",
    tier: "fast",
    kind: "embedding",
    contextWindow: 8_191,
    inputPricePerMtokUsd: "0.02",
    outputPricePerMtokUsd: "0",
    capabilities: {},
  },
  {
    // Used for knowledge search when the org has a Gemini key but no OpenAI key (1536-dim output).
    provider: "google",
    modelKey: "gemini-embedding-001",
    displayName: "Gemini Embedding",
    tier: "fast",
    kind: "embedding",
    contextWindow: 2_048,
    inputPricePerMtokUsd: "0.15",
    outputPricePerMtokUsd: "0",
    capabilities: {},
  },
];

const flagRows = [
  { key: "google_login", description: "Show 'Continue with Google' on auth pages", defaultEnabled: true },
  { key: "byok", description: "Allow organizations to use their own model keys", defaultEnabled: true },
  { key: "signups_open", description: "Allow new self-serve signups", defaultEnabled: true },
];


export async function seedCatalog(db: NodePgDatabase<Record<string, never>>): Promise<string> {
  for (const row of planRows) {
    await db
      .insert(plans)
      .values(row)
      // Insert-only: never overwrite limits the super admin has edited.
      .onConflictDoNothing({ target: plans.key });
  }
  for (const row of modelRows) {
    await db
      .insert(aiModels)
      .values(row)
      // Insert-only: never overwrite prices or settings changed in the admin Models page.
      .onConflictDoNothing({ target: [aiModels.provider, aiModels.modelKey] });
  }
  for (const row of flagRows) {
    await db.insert(featureFlags).values(row).onConflictDoNothing();
  }
  const [{ count }] = (await db.execute<{ count: string }>(sql`select count(*)::text as count from ai_models`)).rows as [
    { count: string },
  ];
  return `Seeded ${planRows.length} plans, ${count} models, ${flagRows.length} feature flags`;
}
