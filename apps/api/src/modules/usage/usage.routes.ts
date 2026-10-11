import { Router } from "express";
import { and, eq, gte, sql } from "drizzle-orm";
import { appDb, withTenant } from "@we360/db";
import { executions, plans, usageRecords } from "@we360/db/schema";
import { tenantOf } from "../../lib/http";
import { requireSession, requireTenant } from "../../middleware/auth";
import { getOrgLimits } from "../plans/plan-limits";
import { getUsageSummary } from "./usage.service";

export const usageRouter = Router();
usageRouter.use(requireSession, requireTenant);

usageRouter.get("/", async (req, res) => {
  const { orgId, planKey } = tenantOf(req);
  const since = new Date(Date.now() - 30 * 86_400_000);
  const [summary, limits, [plan]] = await Promise.all([
    getUsageSummary(orgId),
    getOrgLimits(orgId),
    appDb().select({ name: plans.name }).from(plans).where(eq(plans.key, planKey)),
  ]);
  const daily = await withTenant(orgId, async (tx) => {
    const runs = await tx
      .select({
        day: sql<string>`to_char(date_trunc('day', ${executions.startedAt}), 'YYYY-MM-DD')`,
        messages: sql<number>`count(*) filter (where ${executions.source} <> 'playground')::int`,
        tests: sql<number>`count(*) filter (where ${executions.source} = 'playground')::int`,
        failed: sql<number>`count(*) filter (where ${executions.status} = 'failed')::int`,
      })
      .from(executions)
      .where(gte(executions.startedAt, since))
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    const cost = await tx
      .select({
        day: sql<string>`to_char(date_trunc('day', ${usageRecords.occurredAt}), 'YYYY-MM-DD')`,
        platformUsd: sql<number>`coalesce(sum(${usageRecords.costUsd}) filter (where ${usageRecords.billingSource} = 'platform'), 0)::float`,
        byokUsd: sql<number>`coalesce(sum(${usageRecords.costUsd}) filter (where ${usageRecords.billingSource} = 'byok'), 0)::float`,
        tokens: sql<number>`coalesce(sum(${usageRecords.inputTokens} + ${usageRecords.outputTokens}), 0)::int`,
      })
      .from(usageRecords)
      .where(and(gte(usageRecords.occurredAt, since)))
      .groupBy(sql`1`)
      .orderBy(sql`1`);
    return { runs, cost };
  });
  res.json({ plan: { key: planKey, name: plan?.name ?? planKey }, limits, summary, daily });
});
