import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import {
  bytea,
  createdBy,
  deletedAt,
  id,
  orgId,
  tenantPolicy,
  timestamps,
  tsvector,
  tz,
} from "./_helpers";

/* ------------------------------------------------------------------ */
/* Global tables (no tenant, no RLS). Written only by the super admin. */
/* ------------------------------------------------------------------ */

export interface PlanLimits {
  agents: number | null; // null = unlimited
  messagesPerMonth: number | null;
  platformCreditsUsdPerMonth: number | null;
  knowledgeStorageMb: number | null;
  members: number | null;
  modelTiers: Array<"fast" | "balanced" | "premium">;
  channels: Array<"hosted_page" | "web_widget" | "api">;
  removeBranding: boolean;
  logRetentionDays: number;
}

export const plans = pgTable("plans", {
  key: text("key").primaryKey(), // free | starter | professional | business | enterprise
  name: text("name").notNull(),
  limits: jsonb("limits").$type<PlanLimits>().notNull(),
  isPublic: boolean("is_public").default(true).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
  ...timestamps,
});

export const aiModels = pgTable(
  "ai_models",
  {
    id: id(),
    provider: text("provider").notNull(), // openai | anthropic | google
    modelKey: text("model_key").notNull(), // provider's model id
    displayName: text("display_name").notNull(),
    tier: text("tier").notNull(), // fast | balanced | premium
    kind: text("kind").default("chat").notNull(), // chat | embedding
    contextWindow: integer("context_window").notNull(),
    inputPricePerMtokUsd: numeric("input_price_per_mtok_usd", { precision: 12, scale: 6 }).notNull(),
    outputPricePerMtokUsd: numeric("output_price_per_mtok_usd", { precision: 12, scale: 6 }).notNull(),
    // temperature=false: the provider rejects non-default sampling params (e.g. Claude Opus 5.5 / Sonnet 5.5).
    capabilities: jsonb("capabilities")
      .$type<{ tools?: boolean; vision?: boolean; temperature?: boolean }>()
      .default({})
      .notNull(),
    isEnabled: boolean("is_enabled").default(true).notNull(),
    isDefault: boolean("is_default").default(false).notNull(),
    ...timestamps,
  },
  (t) => [uniqueIndex("ai_models_provider_key_uq").on(t.provider, t.modelKey)],
);

export const featureFlags = pgTable("feature_flags", {
  key: text("key").primaryKey(),
  description: text("description"),
  defaultEnabled: boolean("default_enabled").default(false).notNull(),
  orgOverrides: jsonb("org_overrides").$type<Record<string, boolean>>().default({}).notNull(),
  ...timestamps,
});

/* ------------------------------------------------------------------ */
/* Tenant tables. Every row has org_id and an RLS policy.             */
/* ------------------------------------------------------------------ */

export const workspaces = pgTable(
  "workspaces",
  {
    id: id(),
    orgId: orgId(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdBy: createdBy(),
    ...timestamps,
    deletedAt: deletedAt(),
  },
  (t) => [uniqueIndex("workspaces_org_slug_uq").on(t.orgId, t.slug), tenantPolicy()],
).enableRLS();

export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    orgId: orgId(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(), // first chars shown in UI, e.g. "we360_sk_ab12"
    keyHash: text("key_hash").notNull(), // sha256(secret + pepper), never the secret
    scopes: text("scopes").array().default(sql`'{}'::text[]`).notNull(),
    lastUsedAt: tz("last_used_at"),
    expiresAt: tz("expires_at"),
    revokedAt: tz("revoked_at"),
    createdBy: createdBy(),
    ...timestamps,
  },
  (t) => [uniqueIndex("api_keys_hash_uq").on(t.keyHash), index("api_keys_org_idx").on(t.orgId), tenantPolicy()],
).enableRLS();

/**
 * Credentials hold encrypted secrets: API tool auth and org-level BYOK model keys
 * (integration_key = 'llm.openai' | 'llm.anthropic' | 'llm.google', workspace_id NULL).
 * Plaintext never leaves the tool executor / model gateway.
 */
export const credentials = pgTable(
  "credentials",
  {
    id: id(),
    orgId: orgId(),
    workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
    integrationKey: text("integration_key").notNull(),
    name: text("name").notNull(),
    authType: text("auth_type").notNull(), // api_key | bearer | basic | header
    ciphertext: bytea("ciphertext").notNull(),
    iv: bytea("iv").notNull(),
    authTag: bytea("auth_tag").notNull(),
    encryptedDataKey: bytea("encrypted_data_key").notNull(),
    keyVersion: integer("key_version").default(1).notNull(),
    last4: text("last4"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(), // non-secret only
    status: text("status").default("active").notNull(), // active | invalid
    lastVerifiedAt: tz("last_verified_at"),
    createdBy: createdBy(),
    ...timestamps,
    deletedAt: deletedAt(),
  },
  (t) => [index("credentials_org_idx").on(t.orgId, t.integrationKey), tenantPolicy()],
).enableRLS();

/** Per-org AI provider settings: platform credits vs BYOK, per provider. */
export const orgAiSettings = pgTable(
  "org_ai_settings",
  {
    orgId: orgId().primaryKey(),
    providers: jsonb("providers")
      .$type<Record<string, { mode: "platform" | "byok"; credentialId?: string }>>()
      .default({})
      .notNull(),
    ...timestamps,
  },
  () => [tenantPolicy()],
).enableRLS();

export interface AgentConfig {
  schemaVersion: 1;
  identity: { role?: string; tone?: string; avatarUrl?: string };
  instructions: string;
  model: { modelId: string; temperature?: number; maxOutputTokens?: number; fallbackModelId?: string };
  knowledge: { knowledgeBaseIds: string[]; mode: "auto" | "always"; topK: number };
  tools: Array<{ toolId: string; requiresApproval?: boolean; descriptionOverride?: string }>;
  memory: { maxHistoryMessages: number };
  limits: { maxSteps: number; timeoutMs: number };
  messages: { welcome?: string; fallback?: string };
  variables?: Record<string, string>;
}

export const agents = pgTable(
  "agents",
  {
    id: id(),
    orgId: orgId(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    avatarUrl: text("avatar_url"),
    status: text("status").default("active").notNull(), // active | disabled
    draftConfig: jsonb("draft_config").$type<AgentConfig>().notNull(),
    draftRevision: integer("draft_revision").default(1).notNull(), // optimistic concurrency for autosave
    publishedVersionId: uuid("published_version_id"),
    templateKey: text("template_key"),
    disabledByAdminAt: tz("disabled_by_admin_at"),
    createdBy: createdBy(),
    ...timestamps,
    deletedAt: deletedAt(),
  },
  (t) => [index("agents_ws_idx").on(t.workspaceId).where(sql`deleted_at is null`), tenantPolicy()],
).enableRLS();

export const agentVersions = pgTable(
  "agent_versions",
  {
    id: id(),
    orgId: orgId(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    versionNo: integer("version_no").notNull(),
    config: jsonb("config").$type<AgentConfig>().notNull(), // immutable snapshot
    configHash: text("config_hash").notNull(),
    changeNote: text("change_note"),
    publishedBy: uuid("published_by").references(() => user.id, { onDelete: "set null" }),
    publishedAt: tz("published_at").defaultNow().notNull(),
  },
  (t) => [uniqueIndex("agent_versions_agent_no_uq").on(t.agentId, t.versionNo), tenantPolicy()],
).enableRLS();

/** Templates an organization saved from its own agents, reusable when creating new agents. */
export const agentTemplates = pgTable(
  "agent_templates",
  {
    id: id(),
    orgId: orgId(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    config: jsonb("config").$type<AgentConfig>().notNull(),
    createdBy: createdBy(),
    ...timestamps,
    deletedAt: deletedAt(),
  },
  (t) => [index("agent_templates_ws_idx").on(t.workspaceId), tenantPolicy()],
).enableRLS();

export const tools = pgTable(
  "tools",
  {
    id: id(),
    orgId: orgId(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    providerKey: text("provider_key").notNull(), // http_request | ...
    operationKey: text("operation_key").notNull(),
    name: text("name").notNull(), // model-facing function name
    description: text("description").notNull(),
    inputSchema: jsonb("input_schema").$type<Record<string, unknown>>().notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().default({}).notNull(),
    credentialId: uuid("credential_id").references(() => credentials.id, { onDelete: "set null" }),
    createdBy: createdBy(),
    ...timestamps,
    deletedAt: deletedAt(),
  },
  (t) => [index("tools_ws_idx").on(t.workspaceId), tenantPolicy()],
).enableRLS();

export const knowledgeBases = pgTable(
  "knowledge_bases",
  {
    id: id(),
    orgId: orgId(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    embeddingModel: text("embedding_model").default("openai:text-embedding-3-small").notNull(),
    chunking: jsonb("chunking").$type<{ maxTokens: number; overlap: number }>().default({ maxTokens: 600, overlap: 80 }).notNull(),
    createdBy: createdBy(),
    ...timestamps,
    deletedAt: deletedAt(),
  },
  (t) => [index("kb_ws_idx").on(t.workspaceId), tenantPolicy()],
).enableRLS();

export const agentVersionTools = pgTable(
  "agent_version_tools",
  {
    orgId: orgId(),
    agentVersionId: uuid("agent_version_id")
      .notNull()
      .references(() => agentVersions.id, { onDelete: "cascade" }),
    toolId: uuid("tool_id")
      .notNull()
      .references(() => tools.id, { onDelete: "restrict" }),
    requiresApproval: boolean("requires_approval").default(false).notNull(),
    descriptionOverride: text("description_override"),
  },
  (t) => [primaryKey({ columns: [t.agentVersionId, t.toolId] }), index("avt_tool_idx").on(t.toolId), tenantPolicy()],
).enableRLS();

export const agentVersionKnowledge = pgTable(
  "agent_version_knowledge",
  {
    orgId: orgId(),
    agentVersionId: uuid("agent_version_id")
      .notNull()
      .references(() => agentVersions.id, { onDelete: "cascade" }),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "restrict" }),
  },
  (t) => [
    primaryKey({ columns: [t.agentVersionId, t.knowledgeBaseId] }),
    index("avk_kb_idx").on(t.knowledgeBaseId),
    tenantPolicy(),
  ],
).enableRLS();

export const documents = pgTable(
  "documents",
  {
    id: id(),
    orgId: orgId(),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    sourceType: text("source_type").notNull(), // file | text | url
    title: text("title").notNull(),
    storageKey: text("storage_key"),
    sourceUrl: text("source_url"),
    mimeType: text("mime_type"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).default(0).notNull(),
    contentHash: text("content_hash"),
    status: text("status").default("queued").notNull(), // queued | parsing | embedding | ready | failed
    error: text("error"),
    chunkCount: integer("chunk_count").default(0).notNull(),
    tokenCount: integer("token_count").default(0).notNull(),
    createdBy: createdBy(),
    ...timestamps,
    deletedAt: deletedAt(),
  },
  (t) => [index("documents_kb_idx").on(t.knowledgeBaseId), tenantPolicy()],
).enableRLS();

export const documentChunks = pgTable(
  "document_chunks",
  {
    id: id(),
    orgId: orgId(),
    knowledgeBaseId: uuid("knowledge_base_id")
      .notNull()
      .references(() => knowledgeBases.id, { onDelete: "cascade" }),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    ordinal: integer("ordinal").notNull(),
    content: text("content").notNull(),
    metadata: jsonb("metadata").$type<{ headingPath?: string[]; page?: number }>().default({}).notNull(),
    tokenCount: integer("token_count").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }).notNull(),
    // 'simple' config: language-neutral, works for English, Hindi and mixed content.
    tsv: tsvector("tsv").generatedAlwaysAs(sql`to_tsvector('simple', content)`),
    createdAt: tz("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("chunks_kb_idx").on(t.knowledgeBaseId),
    index("chunks_doc_idx").on(t.documentId),
    index("chunks_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("chunks_tsv_gin").using("gin", t.tsv),
    tenantPolicy(),
  ],
).enableRLS();

export const deployments = pgTable(
  "deployments",
  {
    id: id(),
    orgId: orgId(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    channel: text("channel").notNull(), // hosted_page | web_widget | api
    versionPolicy: text("version_policy").default("latest").notNull(), // latest | pinned
    pinnedVersionId: uuid("pinned_version_id").references(() => agentVersions.id, { onDelete: "restrict" }),
    publicKey: text("public_key"), // pk_... for hosted page / widget
    config: jsonb("config")
      .$type<{ allowedOrigins?: string[]; theme?: Record<string, string>; title?: string; privacyPolicyUrl?: string }>()
      .default({})
      .notNull(),
    status: text("status").default("active").notNull(), // active | paused | disabled_by_admin
    createdBy: createdBy(),
    ...timestamps,
    deletedAt: deletedAt(),
  },
  (t) => [
    index("deployments_agent_idx").on(t.agentId),
    uniqueIndex("deployments_public_key_uq").on(t.publicKey),
    tenantPolicy(),
  ],
).enableRLS();

export const conversations = pgTable(
  "conversations",
  {
    id: id(),
    orgId: orgId(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    deploymentId: uuid("deployment_id").references(() => deployments.id, { onDelete: "set null" }),
    channel: text("channel").notNull(), // playground | hosted_page | web_widget | api
    endUserRef: text("end_user_ref"), // opaque external id; enables long-term memory later
    title: text("title"),
    lastMessageAt: tz("last_message_at"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: tz("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("conversations_agent_idx").on(t.orgId, t.agentId, t.lastMessageAt),
    // Erasure requests look conversations up by end user.
    index("conversations_end_user_idx").on(t.orgId, t.endUserRef),
    tenantPolicy(),
  ],
).enableRLS();

export const messages = pgTable(
  "messages",
  {
    id: id(),
    orgId: orgId(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role").notNull(), // user | assistant | tool
    content: jsonb("content").$type<unknown>().notNull(), // message parts
    executionId: uuid("execution_id"),
    feedback: smallint("feedback"), // 1 | -1
    createdAt: tz("created_at").defaultNow().notNull(),
  },
  (t) => [index("messages_conv_idx").on(t.conversationId, t.createdAt), tenantPolicy()],
).enableRLS();

/**
 * Not partitioned at launch (volume is small); retention deletes in batches by started_at.
 * Partition by month once tables pass ~50M rows.
 */
export const executions = pgTable(
  "executions",
  {
    id: id(),
    orgId: orgId(),
    workspaceId: uuid("workspace_id").notNull(),
    agentId: uuid("agent_id").notNull(),
    agentVersionId: uuid("agent_version_id"), // null when testing a draft
    deploymentId: uuid("deployment_id"),
    conversationId: uuid("conversation_id"),
    source: text("source").notNull(), // playground | hosted_page | web_widget | api
    triggeredByUserId: uuid("triggered_by_user_id"),
    apiKeyId: uuid("api_key_id"),
    status: text("status").notNull(), // running | succeeded | failed | limited | cancelled
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    inputPreview: text("input_preview"),
    outputPreview: text("output_preview"),
    inputTokens: integer("input_tokens").default(0).notNull(),
    outputTokens: integer("output_tokens").default(0).notNull(),
    costUsd: numeric("cost_usd", { precision: 14, scale: 8 }).default("0").notNull(),
    latencyMs: integer("latency_ms"),
    stepCount: integer("step_count").default(0).notNull(),
    startedAt: tz("started_at").defaultNow().notNull(),
    completedAt: tz("completed_at"),
  },
  (t) => [
    index("executions_org_agent_idx").on(t.orgId, t.agentId, t.startedAt),
    index("executions_org_status_idx").on(t.orgId, t.status, t.startedAt),
    index("executions_started_idx").on(t.startedAt),
    index("executions_conversation_idx").on(t.conversationId),
    tenantPolicy(),
  ],
).enableRLS();

export const executionSteps = pgTable(
  "execution_steps",
  {
    id: id(),
    orgId: orgId(),
    executionId: uuid("execution_id")
      .notNull()
      .references(() => executions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(), // llm | tool | retrieval | guardrail
    name: text("name"),
    status: text("status").notNull(),
    input: jsonb("input"), // redacted, size-capped
    output: jsonb("output"),
    modelKey: text("model_key"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    latencyMs: integer("latency_ms"),
    error: text("error"),
    startedAt: tz("started_at").defaultNow().notNull(),
  },
  (t) => [index("steps_exec_idx").on(t.executionId, t.seq), tenantPolicy()],
).enableRLS();

export const usageRecords = pgTable(
  "usage_records",
  {
    id: id(),
    orgId: orgId(),
    workspaceId: uuid("workspace_id"),
    agentId: uuid("agent_id"),
    executionId: uuid("execution_id"),
    provider: text("provider").notNull(),
    modelKey: text("model_key").notNull(),
    kind: text("kind").notNull(), // chat | embedding
    billingSource: text("billing_source").notNull(), // platform | byok
    inputTokens: integer("input_tokens").default(0).notNull(),
    outputTokens: integer("output_tokens").default(0).notNull(),
    costUsd: numeric("cost_usd", { precision: 14, scale: 8 }).default("0").notNull(),
    occurredAt: tz("occurred_at").defaultNow().notNull(),
  },
  (t) => [
    index("usage_org_time_idx").on(t.orgId, t.occurredAt),
    index("usage_time_idx").on(t.occurredAt),
    tenantPolicy(),
  ],
).enableRLS();

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    orgId: uuid("org_id"), // null for platform-level admin actions
    actorType: text("actor_type").notNull(), // user | api_key | platform_admin | system
    actorId: text("actor_id"),
    action: text("action").notNull(), // e.g. agent.published, credential.created, admin.org.plan_changed
    targetType: text("target_type"),
    targetId: text("target_id"),
    diff: jsonb("diff"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: tz("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("audit_org_time_idx").on(t.orgId, t.createdAt),
    index("audit_action_idx").on(t.action, t.createdAt),
    tenantPolicy(),
  ],
).enableRLS();
