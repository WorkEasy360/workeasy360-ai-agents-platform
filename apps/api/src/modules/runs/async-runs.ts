import { eq } from "drizzle-orm";
import { withTenant } from "@we360/db";
import { deployments } from "@we360/db/schema";
import type { RunJob, RunJobResult } from "../../lib/queue";
import { loadLiveAgent } from "../deployments/deployment-resolver";
import { deliverWebhook } from "./webhooks";
import { prepareRun, streamRun } from "./run.service";
import { AppError } from "../../lib/errors";

/** Executes a queued API run in the worker and delivers the optional callback. */
export async function executeRunJob(job: RunJob): Promise<RunJobResult> {
  let result: RunJobResult;
  try {
    const [deployment] = await withTenant(job.orgId, (tx) => tx.select().from(deployments).where(eq(deployments.id, job.deploymentId)));
    if (!deployment || deployment.deletedAt || deployment.status !== "active") {
      throw new AppError(503, "agent_unavailable", "API access for this agent is paused.");
    }
    const live = await loadLiveAgent(job.orgId, deployment);
    const prepared = await prepareRun({
      orgId: job.orgId,
      workspaceId: job.workspaceId,
      agentId: job.agentId,
      agentName: live.agent.name,
      config: live.config,
      agentVersionId: live.versionId,
      input: job.message,
      conversationId: job.conversationId,
      source: "api",
      deploymentId: deployment.id,
      apiKeyId: job.apiKeyId,
      endUserRef: job.endUserRef,
    });

    result = { status: "failed", error: { code: "run_failed", message: "The run ended without a result." } };
    let conversationId: string | undefined;
    for await (const ev of streamRun(prepared)) {
      if (ev.type === "run.started") conversationId = ev.conversationId;
      if (ev.type === "run.completed") {
        result = { executionId: ev.executionId, conversationId, status: ev.limited ? "limited" : "succeeded", output: ev.text, citations: ev.citations };
      }
      if (ev.type === "run.failed") {
        result = { executionId: ev.executionId, conversationId, status: "failed", error: { code: ev.code, message: ev.message } };
      }
    }
  } catch (err) {
    const e = err instanceof AppError ? err : new AppError(500, "run_failed", "Something went wrong while generating a response.");
    result = { status: "failed", error: { code: e.code, message: e.message } };
  }

  if (job.callbackUrl) {
    result.webhook = await deliverWebhook(job.orgId, job.callbackUrl, { type: "run.finished", agentId: job.agentId, ...result });
  }
  return result;
}
