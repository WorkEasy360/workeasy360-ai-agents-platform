import type { NextFunction, Request, RequestHandler, Response } from "express";
import { fromNodeHeaders } from "better-auth/node";
import { and, asc, eq, isNull } from "drizzle-orm";
import { appDb, withTenant } from "@we360/db";
import { member, organization, workspaces } from "@we360/db/schema";
import { auth } from "../auth/auth";
import { AppError } from "../lib/errors";
import type { OrgRole } from "../types/express";

/** Requires a signed-in user. Sets `req.auth`. */
export const requireSession: RequestHandler = async (req, _res, next) => {
  const session = await auth.api.getSession({ headers: fromNodeHeaders(req.headers) });
  if (!session) return next(AppError.unauthorized());
  req.auth = session;
  next();
};

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

  const [row] = await appDb()
    .select({ role: member.role, status: organization.status, planKey: organization.planKey })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(and(eq(member.organizationId, orgId), eq(member.userId, req.auth.user.id)))
    .limit(1);

  // Same response for "not a member" and "doesn't exist", so org ids can't be probed.
  if (!row) return next(AppError.notFound("Organization"));
  if (row.status !== "active") {
    return next(AppError.forbidden("This organization is suspended. Contact support.", "organization_suspended"));
  }

  const workspaceId = await withTenant(orgId, async (tx) => {
    const [ws] = await tx
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(isNull(workspaces.deletedAt))
      .orderBy(asc(workspaces.createdAt))
      .limit(1);
    return ws?.id;
  });
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
