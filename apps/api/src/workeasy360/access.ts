import { AppError } from "../lib/errors";
import { getWorkeasy360Runtime } from "./runtime";

/** The WorkEasy360 fields of a Better Auth session (additionalFields in auth.ts), present only on a WorkEasy360 sign-in. */
export interface Workeasy360SessionFields {
  issuer: string;
  subject: string;
  sid?: string | undefined;
  /** The WorkEasy360 organization the ID token named. */
  organizationId: string;
  /** The one Agents organization this session may use. */
  tenantId: string;
}

type SessionLike = Record<string, unknown> | null | undefined;

export function workeasy360Of(session: SessionLike): Workeasy360SessionFields | undefined {
  const s = session as Record<string, unknown> | null | undefined;
  const issuer = s?.workeasy360Issuer;
  const subject = s?.workeasy360Subject;
  const organizationId = s?.workeasy360OrganizationId;
  const tenantId = s?.workeasy360TenantId;
  if (typeof issuer !== "string" || !issuer || typeof subject !== "string" || typeof organizationId !== "string" || typeof tenantId !== "string") return undefined;
  return { issuer, subject, sid: typeof s?.workeasy360Sid === "string" ? (s.workeasy360Sid as string) : undefined, organizationId, tenantId };
}

/**
 * The per-request rule for a session that Better Auth has just found in the database (requireSession):
 *
 * - with WORKEASY360_SSO_ONLY, a session opened any other way (password, Google) is refused at once;
 * - a WorkEasy360 session is refused when WorkEasy360 sign-in is off, or the session's issuer is not the
 *   configured one (an issuer move needs `move-issuer`).
 *
 * A session ended by a back-channel logout is deleted, so Better Auth no longer finds it: every instance
 * refuses it on its next request (no cookie cache, no secondary storage: see auth.ts).
 */
export function sessionRefusal(session: SessionLike): AppError | undefined {
  const runtime = getWorkeasy360Runtime();
  const w360 = workeasy360Of(session);
  if (w360) {
    if (!runtime || w360.issuer !== runtime.settings.issuer) {
      return new AppError(401, "workeasy360_session_invalid", "Your WorkEasy360 sign-in is no longer valid here. Sign in again.");
    }
    return undefined;
  }
  if (runtime?.settings.ssoOnly) return new AppError(401, "workeasy360_sign_in_required", "Sign in with WorkEasy360 to continue.");
  return undefined;
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** POSTs that only read: a read-only organization can still search its knowledge. */
const READ_LIKE_POSTS = [/\/search$/];

export function isWrite(method: string, path: string): boolean {
  if (SAFE_METHODS.has(method)) return false;
  return !(method === "POST" && READ_LIKE_POSTS.some((p) => p.test(path)));
}

/**
 * Whether WorkEasy360 still entitles the organization (and, for a WorkEasy360 session, the person) to the
 * product. Only for Agents organizations linked to a WorkEasy360 organization; asked of the platform on
 * its advertised cadence, never per request (entitlements.ts).
 *
 * - denial: 403 `workeasy360_access_ended` (with `reason`); the session stays valid, so the person sees why;
 * - the platform refused this product's own client: 403 `workeasy360_access_unverified` (fail closed);
 * - a write while the organization is read-only: 403 `workeasy360_read_only`.
 */
export async function entitlementRefusal(
  workeasy360OrganizationId: string | null | undefined,
  options: { subject?: string | undefined; write: boolean },
): Promise<AppError | undefined> {
  const runtime = getWorkeasy360Runtime();
  if (!runtime || !workeasy360OrganizationId) return undefined;
  const access = await runtime.entitlements.check(workeasy360OrganizationId, { subject: options.subject });
  if (access.status === "refused") {
    return new AppError(403, "workeasy360_access_unverified", "WorkEasy360 Agents cannot confirm your organization's access with WorkEasy360 right now. Try again in a few minutes.");
  }
  if (!access.allowed) {
    return new AppError(403, "workeasy360_access_ended", "Your organization's access to WorkEasy360 Agents has ended.", {
      reason: access.reason,
      purchaseUrl: runtime.settings.purchaseUrl,
    });
  }
  if (options.write && !access.writeAllowed) {
    return new AppError(403, "workeasy360_read_only", "Your organization can view and export, but not make changes, until its subscription is renewed.");
  }
  return undefined;
}

/** Better Auth endpoints (paths relative to /api/auth) that sign someone in without WorkEasy360. */
const LOCAL_SIGN_IN_PATHS = [/^\/sign-in\//, /^\/sign-up\//, /^\/callback\//, /^\/request-password-reset$/, /^\/forget-password$/, /^\/reset-password/, /^\/verify-email$/, /^\/two-factor\/verify/];

/**
 * In front of every Better Auth endpoint (auth.ts hooks.before). Returns an error to throw, or undefined.
 *
 * With WORKEASY360_SSO_ONLY: password and Google sign-in, sign-up and password reset are refused, and so
 * is any call carrying a non-WorkEasy360 session, except sign-out.
 *
 * A WorkEasy360 session works only inside the organization it was opened for: it cannot create, delete,
 * switch to or act on another organization, or accept invitations (WorkEasy360 decides who belongs).
 */
export function authEndpointRefusal(
  path: string,
  request: { session: SessionLike; organizationIds: Array<string | undefined> },
): { status: "FORBIDDEN" | "UNAUTHORIZED"; code: string; message: string } | undefined {
  if (path.startsWith("/workeasy360/")) return undefined;
  const runtime = getWorkeasy360Runtime();
  const w360 = workeasy360Of(request.session);
  if (runtime?.settings.ssoOnly) {
    if (LOCAL_SIGN_IN_PATHS.some((p) => p.test(path))) {
      return { status: "FORBIDDEN", code: "workeasy360_sso_only", message: "Sign in with WorkEasy360." };
    }
    if (request.session && !w360 && path !== "/sign-out") {
      return { status: "UNAUTHORIZED", code: "workeasy360_sign_in_required", message: "Sign in with WorkEasy360 to continue." };
    }
  }
  if (w360 && path.startsWith("/organization/")) {
    if (path === "/organization/create" || path === "/organization/delete") {
      return { status: "FORBIDDEN", code: "workeasy360_organizations", message: "Organizations are managed in WorkEasy360." };
    }
    if (path === "/organization/accept-invitation" || path === "/organization/reject-invitation") {
      return { status: "FORBIDDEN", code: "workeasy360_other_organization", message: "Your WorkEasy360 organization decides who belongs to it." };
    }
    if (request.organizationIds.some((id) => id !== undefined && id !== w360.tenantId)) {
      return { status: "FORBIDDEN", code: "workeasy360_other_organization", message: "This WorkEasy360 sign-in is for another organization." };
    }
  }
  return undefined;
}
