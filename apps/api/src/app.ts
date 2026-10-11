import { randomUUID } from "node:crypto";
import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import { toNodeHandler } from "better-auth/node";
import { sql } from "drizzle-orm";
import { appDb } from "@we360/db";
import { auth } from "./auth/auth";
import { env } from "./config/env";
import { AppError, errorHandler, notFoundHandler } from "./lib/errors";
import { logger, serializeRequest, serializeResponse } from "./lib/logger";
import { rateLimit } from "./lib/rate-limit";
import { adminRouter } from "./modules/admin/admin.routes";
import { agentsRouter } from "./modules/agents/agents.routes";
import { agentTemplatesRouter } from "./modules/agents/agent-templates.routes";
import { aiSettingsRouter } from "./modules/ai-settings/ai-settings.routes";
import { apiKeysRouter } from "./modules/api-keys/api-keys.routes";
import { credentialsRouter } from "./modules/credentials/credentials.routes";
import { deploymentsRouter } from "./modules/deployments/deployments.routes";
import { executionsRouter } from "./modules/executions/executions.routes";
import { knowledgeRouter } from "./modules/knowledge/knowledge.routes";
import { meRouter } from "./modules/me/me.routes";
import { modelsRouter } from "./modules/models/models.routes";
import { organizationRouter } from "./modules/organization/organization.routes";
import { privacyRouter } from "./modules/privacy/privacy.routes";
import { publicRouter } from "./modules/public/public.routes";
import { runsRouter } from "./modules/runs/runs.routes";
import { toolsRouter } from "./modules/tools/tools.routes";
import { usageRouter } from "./modules/usage/usage.routes";
import { workspacesRouter } from "./modules/workspaces/workspaces.routes";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  // Proxy hops in front of the API: 1 locally (Next.js) and behind the ALB; 2 with CloudFront in front.
  app.set("trust proxy", Number(process.env.TRUST_PROXY_HOPS ?? 1));

  app.use(helmet());
  app.use((req, res, next) => {
    // Accept an upstream id (ALB/proxy) only if it looks like one; anything else could forge log lines.
    const incoming = req.header("x-request-id");
    req.id = incoming && /^[A-Za-z0-9._-]{8,128}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader("x-request-id", req.id);
    next();
  });
  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as express.Request).id,
      autoLogging: { ignore: (req) => req.url === "/healthz" },
      // Allow-listed headers, tokens stripped from URLs, shortened IPs (see serializeRequest).
      serializers: { req: serializeRequest, res: serializeResponse },
    }),
  );

  app.get("/healthz", async (_req, res) => {
    await appDb().execute(sql`select 1`);
    res.json({ status: "ok" });
  });

  // Brute-force protection on credential endpoints, shared across API instances via Redis.
  app.use(
    ["/api/auth/sign-in", "/api/auth/sign-up", "/api/auth/request-password-reset", "/api/auth/forget-password", "/api/auth/reset-password"],
    rateLimit({ name: "auth", limit: Number(process.env.AUTH_RATE_LIMIT ?? 10), windowSec: 60, key: (req) => req.ip ?? "unknown" }),
  );
  app.use(["/api/auth/two-factor/verify-totp", "/api/auth/two-factor/verify-backup-code", "/api/auth/two-factor/verify-otp"], rateLimit({ name: "auth-2fa", limit: 5, windowSec: 60, key: (req) => req.ip ?? "unknown" }));
  // Endpoints that check a password or send email: limited per IP so they can't be used to guess passwords or spam inboxes.
  app.use(
    [
      "/api/auth/send-verification-email",
      "/api/auth/organization/invite-member",
      "/api/auth/organization/create",
      "/api/auth/change-password",
      "/api/auth/delete-user",
      "/api/auth/two-factor/enable",
      "/api/auth/two-factor/disable",
    ],
    rateLimit({ name: "auth-sensitive", limit: Number(process.env.AUTH_RATE_LIMIT ?? 10), windowSec: 60, key: (req) => req.ip ?? "unknown" }),
  );

  // Better Auth reads the raw body itself, so it is mounted before express.json().
  app.all("/api/auth/*splat", toNodeHandler(auth));

  app.use(express.json({ limit: "1mb" }));

  // CSRF defense in depth for the cookie-authenticated API. SameSite=Lax already stops other sites, but
  // sibling WorkEasy360 products on *.workeasy360.com count as the same site. Browsers always send Origin
  // on state-changing requests; API-key clients (Authorization header) don't use cookies and are exempt.
  const appOrigin = new URL(env.APP_URL).origin;
  app.use(["/api/v1", "/api/admin/v1"], (req, _res, next) => {
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS" || req.header("authorization")) return next();
    const origin = req.header("origin");
    if (origin && origin !== appOrigin) return next(AppError.forbidden("Cross-site request blocked.", "cross_site_request"));
    if (!origin && req.header("sec-fetch-site") === "cross-site") return next(AppError.forbidden("Cross-site request blocked.", "cross_site_request"));
    next();
  });

  // Signed-in app (session cookie + active org)
  app.use("/api/v1/me", meRouter);
  app.use("/api/v1/workspaces", workspacesRouter);
  app.use("/api/v1/agents/:agentId/deployments", deploymentsRouter);
  app.use("/api/v1/agents", agentsRouter);
  app.use("/api/v1/agent-templates", agentTemplatesRouter);
  app.use("/api/v1/models", modelsRouter);
  app.use("/api/v1/tools", toolsRouter);
  app.use("/api/v1/credentials", credentialsRouter);
  app.use("/api/v1/ai-settings", aiSettingsRouter);
  app.use("/api/v1/api-keys", apiKeysRouter);
  app.use("/api/v1/usage", usageRouter);
  app.use("/api/v1/organization", organizationRouter);
  app.use("/api/v1/privacy", privacyRouter);
  app.use("/api/v1", knowledgeRouter);
  app.use("/api/v1", executionsRouter);

  // Developer API (API key) and public channels (hosted page / widget)
  app.use("/api/v1/runs", runsRouter);
  app.use("/api/public/v1", publicRouter);

  // Super admin
  app.use("/api/admin/v1", adminRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
