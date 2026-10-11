import { createHash, randomBytes } from "node:crypto";
import type { RequestHandler } from "express";
import { and, eq, isNull, sql } from "drizzle-orm";
import { appDb, withTenant } from "@we360/db";
import { apiKeys, organization } from "@we360/db/schema";
import { AppError } from "../../lib/errors";

const PREFIX = "we360_sk_";

/**
 * Keys are stored as a peppered SHA-256 hash; the secret is shown once at creation.
 * Production requires its own API_KEY_PEPPER (checked at startup in config/env.ts) so rotating
 * BETTER_AUTH_SECRET never invalidates customer API keys. Local dev falls back to the auth secret.
 */
export function hashApiKey(secret: string): string {
  const pepper = process.env.API_KEY_PEPPER || process.env.BETTER_AUTH_SECRET;
  if (!pepper) throw new Error("API_KEY_PEPPER is not configured");
  return createHash("sha256").update(`${pepper}:${secret}`).digest("hex");
}

export function generateApiKey(): { secret: string; prefix: string; hash: string } {
  const secret = `${PREFIX}${randomBytes(24).toString("base64url")}`;
  return { secret, prefix: secret.slice(0, PREFIX.length + 6), hash: hashApiKey(secret) };
}

/**
 * Authenticates `Authorization: Bearer we360_sk_...` and sets `req.tenant`.
 * Lookup by hash isn't tenant-scoped (we don't know the tenant yet), so it uses a
 * SECURITY DEFINER function rather than bypassing RLS for the whole request.
 */
export const requireApiKey: RequestHandler = async (req, _res, next) => {
  const header = req.header("authorization") ?? "";
  const secret = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!secret.startsWith(PREFIX)) return next(AppError.unauthorized("Provide an API key: Authorization: Bearer we360_sk_..."));

  const result = await appDb().execute<{ id: string; org_id: string; workspace_id: string }>(
    sql`select * from resolve_api_key(${hashApiKey(secret)})`,
  );
  const key = result.rows[0];
  if (!key) return next(AppError.unauthorized("Invalid or revoked API key."));

  const [org] = await appDb()
    .select({ status: organization.status, planKey: organization.planKey })
    .from(organization)
    .where(eq(organization.id, key.org_id));
  if (!org || org.status !== "active") return next(AppError.forbidden("This organization is suspended.", "organization_suspended"));

  req.tenant = { orgId: key.org_id, workspaceId: key.workspace_id, role: "member", planKey: org.planKey };
  (req as { apiKeyId?: string }).apiKeyId = key.id;
  // Best effort; don't fail the request over it.
  void withTenant(key.org_id, (tx) => tx.update(apiKeys).set({ lastUsedAt: new Date() }).where(and(eq(apiKeys.id, key.id), isNull(apiKeys.revokedAt)))).catch(() => undefined);
  next();
};
