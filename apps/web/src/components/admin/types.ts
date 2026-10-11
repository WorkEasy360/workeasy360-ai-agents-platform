/** Response shapes of the super admin API (`/api/admin/v1`). */

export type PlatformRole = "super_admin" | "support";
export type ModelTier = "fast" | "balanced" | "premium";
export type Channel = "hosted_page" | "web_widget" | "api";

export const MODEL_TIERS: ModelTier[] = ["fast", "balanced", "premium"];
export const CHANNELS: Channel[] = ["hosted_page", "web_widget", "api"];

export interface PlanLimits {
  agents: number | null;
  messagesPerMonth: number | null;
  platformCreditsUsdPerMonth: number | null;
  knowledgeStorageMb: number | null;
  members: number | null;
  modelTiers: ModelTier[];
  channels: Channel[];
  removeBranding: boolean;
  logRetentionDays: number;
}

/** Numeric limits, in display order, with labels. `null` = unlimited (except logRetentionDays). */
export const NUMERIC_LIMITS: Array<{ key: keyof PlanLimits; label: string; step?: string; nullable: boolean }> = [
  { key: "agents", label: "Agents", nullable: true },
  { key: "messagesPerMonth", label: "Messages / month", nullable: true },
  { key: "platformCreditsUsdPerMonth", label: "Platform credits (USD / month)", step: "0.01", nullable: true },
  { key: "knowledgeStorageMb", label: "Knowledge storage (MB)", nullable: true },
  { key: "members", label: "Members", nullable: true },
  { key: "logRetentionDays", label: "Log retention (days)", nullable: false },
];

export interface Plan {
  key: string;
  name: string;
  limits: PlanLimits;
  isPublic: boolean;
  sortOrder: number;
}

export interface Overview {
  organizations: number;
  suspended_organizations: number;
  users: number;
  signups_7d: number;
  active_agents: number;
  runs_today: number;
  runs_30d: number;
  failed_runs_today: number;
  platform_cost_today_usd: string;
  platform_cost_month_usd: string;
  byok_cost_month_usd: string;
  signupsDaily: Array<{ day: string; n: number }>;
}

export interface OrgRow {
  id: string;
  name: string;
  slug: string;
  planKey: string;
  status: string;
  createdAt: string;
  members: number;
  agents: number;
  runs30d: number;
  costMonthUsd: string;
}

export interface OrgAgent {
  id: string;
  name: string;
  status: string;
  disabledByAdminAt: string | null;
  updatedAt: string;
}

export interface OrgDetail {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  planKey: string;
  status: string;
  planOverrides: Partial<PlanLimits> | null;
  plan: Plan | undefined;
  members: Array<{ userId: string; name: string; email: string; role: string; joinedAt: string }>;
  agents: OrgAgent[];
  usageThisMonth: { messages: number; platform_usd: string; byok_usd: string; storage_mb: string };
  byokProviders: string[];
}

export interface UserRow {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  platformRole: PlatformRole | null;
  twoFactorEnabled: boolean | null;
  bannedAt: string | null;
  createdAt: string;
  orgs: number;
  lastSeenAt: string | null;
}

export interface UserDetail {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  createdAt: string;
  twoFactorEnabled: boolean | null;
  platformRole: PlatformRole | null;
  bannedAt: string | null;
  banReason: string | null;
  organizations: Array<{ id: string; name: string; planKey: string; role: string }>;
  sessions: Array<{ id: string; createdAt: string; updatedAt: string; ipAddress: string | null; userAgent: string | null }>;
}

export interface AgentRow {
  id: string;
  name: string;
  orgId: string;
  orgName: string;
  status: string;
  disabledByAdminAt: string | null;
  updatedAt: string;
  runs30d: number;
}

export interface ExecutionRow {
  id: string;
  orgId: string;
  orgName: string | null;
  agentId: string;
  agentName: string | null;
  source: string;
  status: string;
  errorCode: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
  latencyMs: number | null;
  startedAt: string;
}

export interface ExecutionStep {
  id: string;
  seq: number;
  type: string;
  name: string | null;
  status: string;
  input: unknown;
  output: unknown;
  modelKey: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  error: string | null;
  startedAt: string;
}

export interface ExecutionDetail {
  id: string;
  orgId: string;
  workspaceId: string;
  agentId: string;
  agentVersionId: string | null;
  deploymentId: string | null;
  conversationId: string | null;
  source: string;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  inputPreview: string | null;
  outputPreview: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
  latencyMs: number | null;
  stepCount: number;
  startedAt: string;
  completedAt: string | null;
  steps: ExecutionStep[];
}

export interface Usage {
  days: number;
  byModel: Array<{
    provider: string;
    model_key: string;
    billing_source: string;
    kind: string;
    input_tokens: string;
    output_tokens: string;
    cost_usd: number;
  }>;
  byDay: Array<{ day: string; platform_usd: number; byok_usd: number }>;
  topOrgs: Array<{ org_id: string; name: string; plan_key: string; platform_usd: number; runs: number }>;
}

export interface AiModel {
  id: string;
  provider: "openai" | "anthropic" | "google";
  modelKey: string;
  displayName: string;
  tier: ModelTier;
  kind: "chat" | "embedding";
  contextWindow: number;
  inputPricePerMtokUsd: string;
  outputPricePerMtokUsd: string;
  capabilities: { tools?: boolean; vision?: boolean; temperature?: boolean };
  isEnabled: boolean;
  isDefault: boolean;
}

export interface ModelsResponse {
  data: AiModel[];
  platformKeys: { openai: boolean; anthropic: boolean; google: boolean };
  mockMode: boolean;
}

export interface FeatureFlag {
  key: string;
  description: string | null;
  defaultEnabled: boolean;
  orgOverrides: Record<string, boolean>;
  updatedAt: string;
}

export interface Health {
  api: string;
  dbLatencyMs: number;
  ingestQueue: Record<string, number> | { error: string };
  failuresLast24h: Array<{ error_code: string | null; n: number }>;
  documentsLast7d: Array<{ status: string; n: number }>;
  uptimeSec: number;
}

export interface AuditLog {
  id: string;
  orgId: string | null;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  diff: unknown;
  ip: string | null;
  userAgent: string | null;
  createdAt: string;
  actorEmail: string | null;
  orgName: string | null;
}

export interface Page<T> {
  data: T[];
}

export interface CursorPage<T> {
  data: T[];
  nextCursor: string | null;
}
