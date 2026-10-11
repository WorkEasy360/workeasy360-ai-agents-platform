import type { RequestHandler } from "express";
import { env } from "../config/env";
import { AppError } from "../lib/errors";

export type PlatformRole = "super_admin" | "support";

/**
 * Guards the super admin API. Responds 404 (not 403) to non-staff so the admin surface
 * isn't discoverable. Use after `requireSession`.
 */
export function requirePlatformRole(...allowed: PlatformRole[]): RequestHandler {
  return (req, _res, next) => {
    const user = req.auth?.user as { platformRole?: string | null; twoFactorEnabled?: boolean | null } | undefined;
    const role = user?.platformRole as PlatformRole | undefined;
    if (!role || !allowed.includes(role)) return next(AppError.notFound());
    if (env.adminRequire2fa && !user?.twoFactorEnabled) {
      return next(AppError.forbidden("Enable two-factor authentication to use the admin dashboard.", "two_factor_required"));
    }
    next();
  };
}
