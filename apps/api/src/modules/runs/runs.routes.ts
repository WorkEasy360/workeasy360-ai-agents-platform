import { randomUUID } from "node:crypto";
import { Router } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { withTenant } from "@we360/db";
import { deployments } from "@we360/db/schema";
import { AppError } from "../../lib/errors";
import { openSse, parse, tenantOf, uuidParam } from "../../lib/http";
import { getRunsQueue } from "../../lib/queue";
import { rateLimit } from "../../lib/rate-limit";
import { requireApiKey } from "../api-keys/api-keys";
import { loadLiveAgent } from "../deployments/deployment-resolver";
import { getOrgLimits } from "../plans/plan-limits";
import { prepareRun, streamRun, toPublicEvent, type ClientEvent } from "./run.service";

/**
 * Developer API: POST /api/v1/runs/agents/:agentId  (Authorization: Bearer we360_sk_...)
 * The agent needs an active "API" deployment; that's where users switch API access on and off.
 */
export const runsRouter = Router();

const bodySchema = z.object({
  message: z.string().min(1).max(8000),
  conversationId: z.uuid().optional(),
  userId: z.string().max(200).optional().describe("Your end user's id, stored with the conversation"),
  stream: z.boolean().default(false),
  /** Queue the run and return immediately; poll GET /runs/:id or receive a signed callback. */
  async: z.boolean().default(false),
  callbackUrl: z.url().max(2000).optional(),
});

runsRouter.post(
  "/agents/:agentId",
  requireApiKey,
  rateLimit({ name: "api", limit: 120, windowSec: 60, key: (req) => (req as { apiKeyId?: string }).apiKeyId ?? req.ip ?? "" }),
  async (req, res) => {
    const { orgId, workspaceId } = tenantOf(req);
    const agentId = uuidParam(req, "agentId");
    const body = parse(bodySchema, req.body);

    const limits = await getOrgLimits(orgId);
    if (!limits.channels.includes("api")) throw AppError.forbidden("API access isn't included in your plan.", "plan_limit_reached");

    const [deployment] = await withTenant(orgId, (tx) =>
      tx
        .select()
        .from(deployments)
        .where(and(eq(deployments.agentId, agentId), eq(deployments.channel, "api"), isNull(deployments.deletedAt))),
    );
    if (!deployment) throw AppError.notFound("Agent");
    if (deployment.status !== "active") throw new AppError(503, "agent_unavailable", "API access for this agent is paused.");
    const live = await loadLiveAgent(orgId, deployment);

    const prepared = await prepareRun({
      orgId,
      workspaceId,
      agentId,
      agentName: live.agent.name,
      config: live.config,
      agentVersionId: live.versionId,
      input: body.message,
      conversationId: body.conversationId,
      source: "api",
      deploymentId: deployment.id,
      apiKeyId: (req as { apiKeyId?: string }).apiKeyId,
      endUserRef: body.userId,
    });

    if (body.async) {
      const id = randomUUID();
      await getRunsQueue().add(
        "run",
        {
          orgId,
          workspaceId,
          agentId,
          deploymentId: deployment.id,
          apiKeyId: (req as { apiKeyId?: string }).apiKeyId,
          message: body.message,
          conversationId: body.conversationId,
          endUserRef: body.userId,
          callbackUrl: body.callbackUrl,
        },
        { jobId: id, attempts: 1, removeOnComplete: { age: 86_400 }, removeOnFail: { age: 86_400 } },
      );
      return res.status(202).json({ id, status: "queued", statusUrl: `/api/v1/runs/${id}` });
    }

    if (body.stream) {
      const sse = openSse(req, res);
      for await (const ev of streamRun(prepared)) {
        const pub = toPublicEvent(ev);
        if (pub) sse.send(pub);
      }
      return sse.end();
    }

    let started: Extract<ClientEvent, { type: "run.started" }> | undefined;
    for await (const ev of streamRun(prepared)) {
      if (ev.type === "run.started") started = ev;
      if (ev.type === "run.completed") {
        return res.json({
          id: ev.executionId,
          conversationId: started?.conversationId,
          output: ev.text,
          citations: ev.citations,
          status: ev.limited ? "limited" : "succeeded",
        });
      }
      if (ev.type === "run.failed") {
        return res.status(502).type("application/problem+json").json({
          type: "about:blank",
          title: "Run failed",
          status: 502,
          code: ev.code,
          detail: ev.message,
          run_id: ev.executionId,
          request_id: req.id,
        });
      }
    }
  },
);

/** Status of an async run. Results are kept for 24 hours. */
runsRouter.get("/:runId", requireApiKey, async (req, res) => {
  const { orgId } = tenantOf(req);
  const job = await getRunsQueue().getJob(String(req.params.runId));
  // Another tenant's job id looks exactly like a missing one.
  if (!job || job.data.orgId !== orgId) throw AppError.notFound("Run");
  const state = await job.getState();
  if (state === "completed") return res.json({ id: job.id, ...job.returnvalue });
  if (state === "failed") return res.json({ id: job.id, status: "failed", error: { code: "run_failed", message: "The run failed." } });
  res.json({ id: job.id, status: state === "active" ? "running" : "queued" });
});
