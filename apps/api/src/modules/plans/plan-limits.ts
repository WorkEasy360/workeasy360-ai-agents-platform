import { eq } from "drizzle-orm";
import { appDb } from "@we360/db";
import { organization, plans, type PlanLimits } from "@we360/db/schema";

/**
 * Effective limits for an organization: its plan's limits with any per-org overrides
 * (set by the super admin) applied on top. `null` means unlimited.
 */
export async function getOrgLimits(orgId: string): Promise<PlanLimits> {
  const [row] = await appDb()
    .select({ limits: plans.limits, overrides: organization.planOverrides })
    .from(organization)
    .innerJoin(plans, eq(plans.key, organization.planKey))
    .where(eq(organization.id, orgId))
    .limit(1);
  if (!row) throw new Error(`No plan found for organization ${orgId}`);
  return { ...row.limits, ...((row.overrides as Partial<PlanLimits> | null) ?? {}) };
}

/** Converts a nullable limit to a number for libraries that need one. */
export function limitOrInfinity(limit: number | null): number {
  return limit ?? Number.MAX_SAFE_INTEGER;
}
