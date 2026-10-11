import { eq } from "drizzle-orm";
import { appDb } from "@we360/db";
import { organization, plans, type PlanLimits } from "@we360/db/schema";
import { ttlCache } from "../../lib/ttl-cache";

/**
 * Effective limits for an organization: its plan's limits with any per-org overrides
 * (set by the super admin) applied on top. `null` means unlimited.
 */
// Read on most requests; plan changes are rare. Admin edits clear it (clearOrgLimits); the TTL bounds
// staleness in other processes.
const cache = ttlCache<string, PlanLimits>(30_000);

/** Call after changing an organization's plan or overrides (orgId), or any plan's limits (no argument). */
export function clearOrgLimits(orgId?: string): void {
  if (orgId) cache.delete(orgId);
  else cache.clear();
}

export function getOrgLimits(orgId: string): Promise<PlanLimits> {
  return cache.get(orgId, () => loadOrgLimits(orgId));
}

async function loadOrgLimits(orgId: string): Promise<PlanLimits> {
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
