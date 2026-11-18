import express, { Router } from "express";
import { logger } from "../lib/logger";
import { Workeasy360Error } from "./client";
import { getWorkeasy360Runtime } from "./runtime";
import { endSessions } from "./store";

/** A logout token is a compact JWS of well under 2 KB; anything much larger is not one. */
const MAX_LOGOUT_TOKEN_LENGTH = 16 * 1024;

/**
 * Mounted at /api/auth/workeasy360 before Better Auth's handler (the sign-in page learns what to offer
 * from GET /api/public/v1/platform):
 *
 * - `POST /backchannel-logout`: the OpenID Connect Back-Channel Logout receiver. Server to server: no
 *   cookie, no CSRF token; the provider's signature is the authentication. 200 when the token verifies
 *   (a duplicate too: delivery is at least once), 400 when it does not, 503 when the key set or the
 *   database cannot be reached (nothing recorded; the provider delivers it again).
 */
export function workeasy360Router(): Router {
  const router = Router();

  router.post("/backchannel-logout", express.urlencoded({ extended: false, limit: "32kb" }), async (req, res) => {
    res.set("Cache-Control", "no-store");
    const runtime = getWorkeasy360Runtime();
    if (!runtime) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const body = req.body as Record<string, unknown> | undefined;
    const raw = req.is("application/x-www-form-urlencoded") ? body?.logout_token : undefined;
    if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_LOGOUT_TOKEN_LENGTH) {
      logger.warn({ reqId: req.id, detail: "no logout_token form field" }, "workeasy360 logout token rejected");
      res.status(400).json({ error: "invalid_request" });
      return;
    }
    let token;
    try {
      token = await runtime.client.verifyLogoutToken(raw);
    } catch (err) {
      if (err instanceof Workeasy360Error && err.code === "invalid_token") {
        logger.warn({ reqId: req.id, detail: err.detail }, "workeasy360 logout token rejected");
        res.status(400).json({ error: "invalid_request" });
        return;
      }
      logger.error({ reqId: req.id, detail: err instanceof Workeasy360Error ? err.code : err instanceof Error ? err.name : "unknown" }, "workeasy360 logout token could not be verified");
      res.status(503).json({ error: "temporarily_unavailable" });
      return;
    }
    try {
      const outcome = await endSessions({ issuer: runtime.settings.issuer, jti: token.jti, subject: token.sub, sid: token.sid, acceptableUntil: token.acceptableUntil });
      logger.info(
        { reqId: req.id, jti: token.jti, by: token.sid ? "sid" : "sub", replayed: outcome.replayed, sessionsEnded: outcome.sessionsEnded },
        "workeasy360 back-channel logout",
      );
      res.status(200).end();
    } catch (err) {
      logger.error({ reqId: req.id, detail: err instanceof Error ? err.name : "unknown" }, "workeasy360 back-channel logout failed");
      res.status(503).json({ error: "temporarily_unavailable" });
    }
  });

  return router;
}
