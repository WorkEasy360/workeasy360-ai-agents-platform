import type { NextFunction, Request, RequestHandler, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { and, asc, eq, isNull } from "drizzle-orm";
import { appDb, withTenant } from "@we360/db";
import { member, organization, workeasy360Organizations, workspaces } from "@we360/db/schema";
import { auth } from "../auth/auth";
import { AppError } from "../lib/errors";
import { ttlCache } from "../lib/ttl-cache";
import type { OrgRole } from "../types/express";
import { entitlementRefusal, isWrite, sessionRefusal, workeasy360Of } from "../workeasy360/access";

/**
 * Requires a signed-in user. Sets `req.auth`. The session is read from the database on every request, so a
 * session ended anywhere (sign-out, WorkEasy360 back-channel logout) is refused here at once; WorkEasy360's
 * rules for sessions (SSO-only, the configured issuer) are applied too (src/workeasy360/access.ts).
 */
export const requireSession: RequestHandler = async (req, _res, next) => {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) return next(AppError.unauthorized());
  const refusal = sessionRefusal(session.session as unknown as Record<string, unknown>);
  if (refusal) return next(refusal);
  req.auth = session;
  next();
};

const defaultWorkspace = ttlCache<string, string | undefined>(10 * 60_000);

/**
 * Resolves the active organization for the request and sets `req.tenant`.
 * The org comes from the `X-Org-Id` header or the session's active organization, and the user
 * must be a member of it. Suspended organizations are blocked here, before any handler runs.
 */
export const requireTenant: RequestHandler = async (req, _res, next) => {
  if (!req.auth) return next(AppError.unauthorized());
  const headerOrg = req.header("x-org-id");
  const orgId = headerOrg || req.auth.session.activeOrganizationId;
  if (!orgId) return next(AppError.forbidden("Select or create an organization first.", "no_active_organization"));
  // A WorkEasy360 session reaches only the organization its ID token named; any other is "not found".
  const w360 = workeasy360Of(req.auth.session as unknown as Record<string, unknown>);
  if (w360 && orgId !== w360.tenantId) return next(AppError.notFound("Organization"));

  const [row] = await appDb()
    .select({ role: member.role, status: organization.status, planKey: organization.planKey, workeasy360OrganizationId: workeasy360Organizations.organizationId })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .leftJoin(workeasy360Organizations, eq(workeasy360Organizations.tenantId, organization.id))
    .where(and(eq(member.organizationId, orgId), eq(member.userId, req.auth.user.id)))
    .limit(1);

  // Same response for "not a member" and "doesn't exist", so org ids can't be probed.
  if (!row) return next(AppError.notFound("Organization"));
  if (row.status !== "active") {
    return next(AppError.forbidden("This organization is suspended. Contact support.", "organization_suspended"));
  }
  // Organizations linked to WorkEasy360: used only while WorkEasy360 entitles them (and, for a WorkEasy360
  // session, the person), asked on the platform's cadence. Role checks follow, as before.
  const refusal = await entitlementRefusal(w360 ? w360.organizationId : row.workeasy360OrganizationId, {
    subject: w360?.subject,
    write: isWrite(req.method, req.originalUrl.split("?")[0] ?? ""),
  });
  if (refusal) return next(refusal);

  // Membership and status are checked on every request (above); the default workspace never changes, so
  // it is cached (saves a transaction per request with the database in another region).
  const workspaceId = await defaultWorkspace.get(orgId, () =>
    withTenant(orgId, async (tx) => {
      const [ws] = await tx
        .select({ id: workspaces.id })
        .from(workspaces)
        .where(isNull(workspaces.deletedAt))
        .orderBy(asc(workspaces.createdAt))
        .limit(1);
      return ws?.id;
    }),
  );
  if (!workspaceId) return next(new AppError(500, "workspace_missing", "Organization has no workspace."));

  req.tenant = { orgId, workspaceId, role: row.role as OrgRole, planKey: row.planKey };
  next();
};

const rank: Record<OrgRole, number> = { member: 1, admin: 2, owner: 3 };

/** Requires at least the given org role. Use after `requireTenant`. */
export function requireRole(min: OrgRole): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const role = req.tenant?.role;
    if (!role || rank[role] < rank[min]) return next(AppError.forbidden());
    next();
  };
}
