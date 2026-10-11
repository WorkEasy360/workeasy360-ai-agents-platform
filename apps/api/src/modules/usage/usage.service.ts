import { and, count, eq, gte, sql, sum } from "drizzle-orm";
import { type Tx, withTenant } from "@we360/db";
import { agents, documents, executions, organization, plans, type PlanLimits, usageRecords } from "@we360/db/schema";
import { AppError } from "../../lib/errors";
import { type AiModel, costUsd } from "../models/catalog";
import type { BillingSource } from "../models/gateway";
import { getOrgLimits } from "../plans/plan-limits";

export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export async function recordUsage(u: {
  orgId: string;
  workspaceId?: string;
  agentId?: string;
  executionId?: string;
  model: AiModel;
  kind: "chat" | "embedding";
  billingSource: BillingSource;
  inputTokens: number;
  outputTokens: number;
}): Promise<number> {
  const cost = costUsd(u.model, u.inputTokens, u.outputTokens);
  await withTenant(u.orgId, (tx) =>
    tx.insert(usageRecords).values({
      orgId: u.orgId,
      workspaceId: u.workspaceId,
      agentId: u.agentId,
      executionId: u.executionId,
      provider: u.model.provider,
      modelKey: u.model.modelKey,
      kind: u.kind,
      billingSource: u.billingSource,
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      costUsd: cost.toFixed(8),
    }),
  );
  return cost;
}

export interface UsageSummary {
  periodStart: string;
  messages: number;
  platformCreditsUsd: number;
  byokCostUsd: number;
  agents: number;
  storageMb: number;
}

export async function getUsageSummary(orgId: string): Promise<UsageSummary> {
  const since = monthStart();
  // Queries run one after another: a transaction's connection can't run them in parallel.
  return withTenant(orgId, async (tx) => {
    // Only real conversations count toward the plan; playground tests don't.
    const [msgs] = await tx
      .select({ n: count() })
      .from(executions)
      .where(and(gte(executions.startedAt, since), sql`${executions.source} <> 'playground'`));
    const costs = await tx
      .select({ source: usageRecords.billingSource, total: sum(usageRecords.costUsd) })
      .from(usageRecords)
      .where(gte(usageRecords.occurredAt, since))
      .groupBy(usageRecords.billingSource);
    const [agentCount] = await tx.select({ n: count() }).from(agents).where(sql`${agents.deletedAt} is null`);
    const [storage] = await tx
      .select({ bytes: sum(documents.sizeBytes) })
      .from(documents)
      .where(sql`${documents.deletedAt} is null`);
    const cost = (s: string) => Number(costs.find((c) => c.source === s)?.total ?? 0);
    return {
      periodStart: since.toISOString(),
      messages: msgs?.n ?? 0,
      platformCreditsUsd: cost("platform"),
      byokCostUsd: cost("byok"),
      agents: agentCount?.n ?? 0,
      storageMb: Number(storage?.bytes ?? 0) / (1024 * 1024),
    };
  });
}

/**
 * Pre-flight check before a run. Playground runs are allowed while credits remain
 * (they spend real tokens) but don't count toward the monthly message limit.
 */
export async function assertCanRun(orgId: string, opts: { source: string; billingSource: BillingSource }) {
  const [limits, usage] = await Promise.all([getOrgLimits(orgId), getUsageSummary(orgId)]);
  if (opts.source !== "playground" && limits.messagesPerMonth !== null && usage.messages >= limits.messagesPerMonth) {
    throw new AppError(
      429,
      "plan_limit_reached",
      `This organization has used all ${limits.messagesPerMonth} messages included this month. Upgrade to continue.`,
    );
  }
  if (
    opts.billingSource === "platform" &&
    limits.platformCreditsUsdPerMonth !== null &&
    usage.platformCreditsUsd >= limits.platformCreditsUsdPerMonth
  ) {
    throw new AppError(
      429,
      "credits_exhausted",
      "This month's AI credits are used up. Upgrade your plan or add your own model key in AI settings.",
    );
  }
}

/** Throws if creating one more of something would exceed the plan. */
export async function assertWithinLimit(orgId: string, what: "agents" | "storage", addMb = 0) {
  const [limits, usage] = await Promise.all([getOrgLimits(orgId), getUsageSummary(orgId)]);
  if (what === "agents" && limits.agents !== null && usage.agents >= limits.agents) {
    throw AppError.forbidden(
      `Your plan includes ${limits.agents} agent${limits.agents === 1 ? "" : "s"}. Upgrade to create more.`,
      "plan_limit_reached",
    );
  }
  if (what === "storage" && limits.knowledgeStorageMb !== null && usage.storageMb + addMb > limits.knowledgeStorageMb) {
    throw AppError.forbidden(
      `Your plan includes ${limits.knowledgeStorageMb} MB of knowledge storage. Remove documents or upgrade.`,
      "plan_limit_reached",
    );
  }
}

/**
 * Plan limit check that is safe under concurrency: takes a per-org, per-quota advisory lock for the
 * rest of `tx`, then checks. Parallel requests queue on the lock, so each sees the rows the previous
 * one committed and N requests can't all pass a check that only one should. Call inside the
 * transaction that inserts the new row.
 */
export async function lockAndAssertWithinLimit(tx: Tx, orgId: string, what: "agents" | "storage", addMb = 0) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`quota:${what}:${orgId}`}, 0))`);
  // Everything below runs on this transaction's connection: borrowing another pool connection while
  // holding the lock could stall when concurrent requests are queued on the lock holding the rest.
  const [row] = await tx
    .select({ limits: plans.limits, overrides: organization.planOverrides })
    .from(organization)
    .innerJoin(plans, eq(plans.key, organization.planKey))
    .where(eq(organization.id, orgId));
  const limits = { ...row!.limits, ...((row!.overrides as Partial<PlanLimits> | null) ?? {}) };
  if (what === "agents" && limits.agents !== null) {
    const [c] = await tx.select({ n: count() }).from(agents).where(sql`${agents.deletedAt} is null`);
    if ((c?.n ?? 0) >= limits.agents) {
      throw AppError.forbidden(`Your plan includes ${limits.agents} agent${limits.agents === 1 ? "" : "s"}. Upgrade to create more.`, "plan_limit_reached");
    }
  }
  if (what === "storage" && limits.knowledgeStorageMb !== null) {
    const [c] = await tx.select({ bytes: sum(documents.sizeBytes) }).from(documents).where(sql`${documents.deletedAt} is null`);
    if (Number(c?.bytes ?? 0) / (1024 * 1024) + addMb > limits.knowledgeStorageMb) {
      throw AppError.forbidden(`Your plan includes ${limits.knowledgeStorageMb} MB of knowledge storage. Remove documents or upgrade.`, "plan_limit_reached");
    }
  }
}
