import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { withTenant } from "@we360/db";
import { conversations, executions, messages } from "@we360/db/schema";
import { env } from "../../config/env";
import { AppError } from "../../lib/errors";
import { openSse, parse } from "../../lib/http";
import { rateLimit } from "../../lib/rate-limit";
import { resolvePublicDeployment } from "../deployments/deployment-resolver";
import { getOrgLimits } from "../plans/plan-limits";
import { eraseConversations } from "../privacy/privacy.service";
import { prepareRun, streamRun, toPublicEvent } from "../runs/run.service";

/**
 * Unauthenticated endpoints for the hosted chat page and the web widget.
 * The widget runs in an iframe on our own origin; which sites may embed it is enforced
 * by the browser via CSP frame-ancestors (set by the web app from `allowedOrigins`).
 */
export const publicRouter = Router();

/** What the sign-in pages need to know about this server (no secrets). */
publicRouter.get("/platform", (_req, res) => {
  res.json({ emailEnabled: env.emailEnabled, signupOpen: env.allowPublicSignup });
});

publicRouter.get("/deployments/:publicKey", async (req, res) => {
  const { deployment, agent, config } = await resolvePublicDeployment(String(req.params.publicKey));
  const limits = await getOrgLimits(deployment.orgId);
  res.set("cache-control", "public, max-age=30");
  res.json({
    channel: deployment.channel,
    title: deployment.config.title || agent.name,
    agentName: agent.name,
    avatarUrl: agent.avatarUrl,
    welcomeMessage: config.messages.welcome ?? null,
    theme: deployment.config.theme ?? {},
    allowedOrigins: deployment.config.allowedOrigins ?? [],
    privacyPolicyUrl: deployment.config.privacyPolicyUrl ?? null,
    showBranding: !limits.removeBranding,
  });
});

const messageSchema = z.object({
  message: z.string().min(1).max(4000),
  conversationId: z.uuid().optional(),
  visitorId: z.string().max(100).optional(),
});

publicRouter.post(
  "/deployments/:publicKey/messages",
  rateLimit({ name: "public-ip", limit: 20, windowSec: 60, key: (req) => req.ip ?? "unknown" }),
  rateLimit({ name: "public-deployment", limit: 600, windowSec: 60, key: (req) => String(req.params.publicKey ?? "") }),
  async (req, res) => {
    const body = parse(messageSchema, req.body);
    const { deployment, agent, config, versionId } = await resolvePublicDeployment(String(req.params.publicKey));
    if (deployment.channel === "api") throw AppError.notFound("Agent");

    const prepared = await prepareRun({
      orgId: deployment.orgId,
      workspaceId: deployment.workspaceId,
      agentId: agent.id,
      agentName: agent.name,
      config,
      agentVersionId: versionId,
      input: body.message,
      conversationId: body.conversationId,
      source: deployment.channel as "hosted_page" | "web_widget",
      deploymentId: deployment.id,
      endUserRef: body.visitorId,
    });
    const sse = openSse(req, res);
    for await (const ev of streamRun(prepared)) {
      const pub = toPublicEvent(ev);
      if (pub) sse.send(pub);
    }
    sse.end();
  },
);

/**
 * Lets a visitor delete their own conversation ("Delete this chat"). The visitor id from their
 * browser must match the one the conversation was started with, in this deployment.
 */
publicRouter.delete(
  "/deployments/:publicKey/conversations/:conversationId",
  rateLimit({ name: "public-delete", limit: 10, windowSec: 60, key: (req) => req.ip ?? "unknown" }),
  async (req, res) => {
    const conversationId = parse(z.uuid(), req.params.conversationId);
    const { visitorId } = parse(z.object({ visitorId: z.string().min(1).max(100) }), req.body);
    const { deployment } = await resolvePublicDeployment(String(req.params.publicKey));
    await withTenant(deployment.orgId, (tx) =>
      eraseConversations(
        tx,
        and(eq(conversations.id, conversationId), eq(conversations.deploymentId, deployment.id), eq(conversations.endUserRef, visitorId))!,
      ),
    );
    // Same response whether or not it existed, so conversation ids can't be probed.
    res.json({ ok: true });
  },
);

publicRouter.post(
  "/deployments/:publicKey/feedback",
  rateLimit({ name: "public-feedback", limit: 30, windowSec: 60, key: (req) => req.ip ?? "unknown" }),
  async (req, res) => {
    const body = parse(z.object({ executionId: z.uuid(), conversationId: z.uuid(), value: z.union([z.literal(1), z.literal(-1)]) }), req.body);
    const { deployment } = await resolvePublicDeployment(String(req.params.publicKey));
    // Only the assistant message for this run, in this deployment's conversation, can be rated.
    await withTenant(deployment.orgId, async (tx) => {
      const [exec] = await tx
        .select({ id: executions.id })
        .from(executions)
        .where(and(eq(executions.id, body.executionId), eq(executions.conversationId, body.conversationId), eq(executions.deploymentId, deployment.id)));
      if (!exec) throw AppError.notFound("Message");
      await tx
        .update(messages)
        .set({ feedback: body.value })
        .where(and(eq(messages.executionId, body.executionId), eq(messages.role, "assistant")));
    });
    res.json({ ok: true });
  },
);
