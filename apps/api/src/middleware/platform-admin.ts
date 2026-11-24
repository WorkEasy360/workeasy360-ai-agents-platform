import type { RequestHandler } from "express";
import { env } from "../config/env";
import { AppError } from "../lib/errors";
import { adminStepUpRefusal } from "../workeasy360/step-up";

export type PlatformRole = "super_admin" | "support";

/**
 * Guards the super admin API. Responds 404 (not 403) to non-staff so the admin surface
 * isn't discoverable. Use after `requireSession`.
 *
 * Two-factor authentication: with ADMIN_REQUIRE_2FA (on in production) staff must have it enabled. A password
 * session of such a user already passed it at sign-in; a WorkEasy360 session must present it once for itself
 * (403 `two_factor_step_up_required` until then: src/workeasy360/step-up.ts).
 */
export function requirePlatformRole(...allowed: PlatformRole[]): RequestHandler {
  return (req, _res, next) => {
    const user = req.auth?.user as { platformRole?: string | null; twoFactorEnabled?: boolean | null } | undefined;
    const role = user?.platformRole as PlatformRole | undefined;
    if (!role || !allowed.includes(role)) return next(AppError.notFound());
    if (env.adminRequire2fa && !user?.twoFactorEnabled) {
      return next(AppError.forbidden("Enable two-factor authentication to use the admin dashboard.", "two_factor_required"));
    }
    const stepUp = adminStepUpRefusal(req.auth?.session as unknown as Record<string, unknown> | undefined, user);
    if (stepUp) return next(stepUp);
    next();
  };
}
