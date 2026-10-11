import { and, eq, isNull, sql } from "drizzle-orm";
import { appDb, withTenant } from "@we360/db";
import { type AgentConfig, agentVersions, agents, deployments, organization } from "@we360/db/schema";
import { AppError } from "../../lib/errors";

export interface ResolvedDeployment {
  deployment: typeof deployments.$inferSelect;
  agent: typeof agents.$inferSelect;
  versionId: string;
  config: AgentConfig;
  planKey: string;
}

/** Live config for a deployment: "latest" follows the published version; "pinned" stays fixed. */
export async function loadLiveAgent(orgId: string, deployment: typeof deployments.$inferSelect): Promise<Omit<ResolvedDeployment, "planKey" | "deployment">> {
  return withTenant(orgId, async (tx) => {
    const [agent] = await tx.select().from(agents).where(and(eq(agents.id, deployment.agentId), isNull(agents.deletedAt)));
    if (!agent || agent.status !== "active" || agent.disabledByAdminAt) {
      throw new AppError(503, "agent_unavailable", "This agent is currently unavailable.");
    }
    const versionId = deployment.versionPolicy === "pinned" ? deployment.pinnedVersionId : agent.publishedVersionId;
    if (!versionId) throw new AppError(503, "agent_not_published", "This agent hasn't been published yet.");
    const [version] = await tx.select().from(agentVersions).where(eq(agentVersions.id, versionId));
    if (!version) throw new AppError(503, "agent_not_published", "This agent hasn't been published yet.");
    return { agent, versionId, config: version.config };
  });
}

/** Public deployments (hosted page / widget) by public key. */
export async function resolvePublicDeployment(publicKey: string): Promise<ResolvedDeployment> {
  const result = await appDb().execute<{ id: string; org_id: string }>(sql`select id, org_id from resolve_deployment(${publicKey})`);
  const ref = result.rows[0];
  if (!ref) throw AppError.notFound("Agent");

  const [org] = await appDb().select({ status: organization.status, planKey: organization.planKey }).from(organization).where(eq(organization.id, ref.org_id));
  if (!org || org.status !== "active") throw new AppError(503, "agent_unavailable", "This agent is currently unavailable.");

  const [deployment] = await withTenant(ref.org_id, (tx) => tx.select().from(deployments).where(eq(deployments.id, ref.id)));
  if (!deployment || deployment.status !== "active") throw new AppError(503, "agent_unavailable", "This agent is currently unavailable.");
  return { deployment, planKey: org.planKey, ...(await loadLiveAgent(ref.org_id, deployment)) };
}
