import { randomBytes } from "node:crypto";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { deleteSessionCookie, setSessionCookie } from "better-auth/cookies";
import { logger } from "../lib/logger";
import { workeasy360Of } from "./access";
import { Workeasy360Error } from "./client";
import { getWorkeasy360Runtime } from "./runtime";
import { idTokenOfSession, provisionSignIn, saveLoginFlow, takeLoginFlow } from "./store";

/** How long a sign-in may take between the redirect to WorkEasy360 and the callback. */
export const FLOW_TTL_SECONDS = 600;
const MAX_CODE_LENGTH = 2048;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Pages someone may be sent back to after signing in: a same-site path, nothing else. */
const RETURN_TO = /^\/(?![/\\])[A-Za-z0-9/_.-]{0,300}$/;

/**
 * Why a WorkEasy360 sign-in did not complete, as the sign-in page shows it (`/login?sso_error=<code>`).
 * A fixed vocabulary: never a token, a code, a state or a provider's description.
 */
export type SsoErrorCode =
  | "not_configured"
  | "expired"
  | "unavailable"
  | "rate_limited"
  | "cancelled"
  | "refused"
  | "invalid_token"
  | "wrong_product"
  | "no_organization"
  | "email_unverified"
  | "wrong_organization"
  | "not_entitled"
  | "membership_inactive"
  | "organization_inactive"
  | "integration_suspended"
  | "access_policy_denied"
  | "access_unverified"
  | "tenant_suspended"
  | "no_tenant"
  | "identity_conflict"
  | "account_exists"
  | "account_suspended";

/** The provider's OAuth error codes (OIDC contract §7) with a message of their own. */
const PROVIDER_ERRORS: Record<string, SsoErrorCode> = {
  access_denied: "cancelled",
  invalid_grant: "expired",
  product_not_entitled: "not_entitled",
  membership_inactive: "membership_inactive",
  organization_inactive: "organization_inactive",
  integration_suspended: "integration_suspended",
  access_policy_denied: "access_policy_denied",
  temporarily_unavailable: "unavailable",
  server_error: "unavailable",
};

/** Entitlement reasons (entitlement API §4) the sign-in page explains. */
const DENIAL_REASONS = new Set(["not_entitled", "expired", "suspended", "read_only", "membership_inactive", "no_seat"]);

class SignInRefused extends Error {
  constructor(
    readonly code: SsoErrorCode,
    readonly detail: string,
    readonly reason?: string,
  ) {
    super(detail);
  }
}

function codeForError(err: unknown): SsoErrorCode {
  if (err instanceof SignInRefused) return err.code;
  if (err instanceof Workeasy360Error) {
    switch (err.code) {
      case "state_mismatch":
        return "expired";
      case "sign_in_refused":
        return PROVIDER_ERRORS[err.detail] ?? "refused";
      case "wrong_product":
      case "no_organization":
      case "email_unverified":
      case "invalid_token":
      case "rate_limited":
        return err.code;
      case "provider_refused":
        return "access_unverified";
      default:
        return "unavailable";
    }
  }
  if (err instanceof APIError && err.statusCode === 403) return "account_suspended";
  return "unavailable";
}

function describe(err: unknown): string {
  if (err instanceof SignInRefused) return err.detail;
  if (err instanceof Workeasy360Error) return err.detail || err.code;
  return err instanceof Error ? err.name : "unknown";
}

function flowCookieName(secure: boolean): string {
  // `__Host-`: only this exact host can have set it, so a sibling *.workeasy360.com product cannot plant a flow.
  return secure ? "__Host-we360_w360_flow" : "we360_w360_flow";
}

/**
 * "Continue with WorkEasy360" as Better Auth endpoints under /api/auth, so the session it opens is an
 * ordinary Better Auth session (same table, same signed cookie) and every existing route keeps working:
 *
 * - `GET /workeasy360/start[?organization=<uuid>][&returnTo=/path]`: state, nonce and the PKCE verifier
 *   are kept in PostgreSQL (single use, 10 minutes); the browser holds only a random flow id in an httpOnly
 *   cookie; then the redirect to WorkEasy360, with the organization the launcher named, if any;
 * - `GET /workeasy360/callback`: takes the flow first whatever happens next, compares the state, exchanges
 *   the code (private_key_jwt + PKCE), verifies the ID token, asks the entitlement endpoint, maps the
 *   person and organization, ends any session this browser already held, and opens a session bound to
 *   that one organization;
 * - `POST /workeasy360/sign-out`: ends this product's session, then answers with WorkEasy360's
 *   end_session_endpoint (id_token_hint, post_logout_redirect_uri) for the browser to visit.
 *
 * Failures land on `/login?sso_error=<code>`; details go to the log only.
 */
export function workeasy360Plugin(): BetterAuthPlugin {
  return {
    id: "workeasy360",
    endpoints: {
      workeasy360Start: createAuthEndpoint("/workeasy360/start", { method: "GET" }, async (ctx) => {
        const runtime = getWorkeasy360Runtime();
        const appUrl = new URL(ctx.context.baseURL).origin;
        const fail = (code: SsoErrorCode, detail: string): never => {
          logger.warn({ code, detail }, "workeasy360 sign-in could not start");
          throw ctx.redirect(`${appUrl}/login?sso_error=${code}`);
        };
        if (!runtime) return fail("not_configured", "WorkEasy360 sign-in is off");
        const query = (ctx.query ?? {}) as Record<string, unknown>;
        const raw = typeof query.organization === "string" ? query.organization : "";
        // Only a UUID is forwarded; anything else is dropped and the provider shows its own chooser.
        const organizationId = UUID_PATTERN.test(raw) ? raw.toLowerCase() : null;
        const returnTo = typeof query.returnTo === "string" && RETURN_TO.test(query.returnTo) ? query.returnTo : null;
        let url: URL;
        try {
          const request = await runtime.client.beginLogin({ organizationId: organizationId ?? undefined });
          const flowId = randomBytes(32).toString("base64url");
          await saveLoginFlow(flowId, { state: request.state, nonce: request.nonce, codeVerifier: request.codeVerifier, organizationId, returnTo }, FLOW_TTL_SECONDS);
          const secure = appUrl.startsWith("https://");
          ctx.setCookie(flowCookieName(secure), flowId, { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: FLOW_TTL_SECONDS });
          url = request.url;
        } catch (err) {
          return fail(codeForError(err), describe(err));
        }
        throw ctx.redirect(url.toString());
      }),

      workeasy360Callback: createAuthEndpoint("/workeasy360/callback", { method: "GET" }, async (ctx) => {
        const runtime = getWorkeasy360Runtime();
        const appUrl = new URL(ctx.context.baseURL).origin;
        const secure = appUrl.startsWith("https://");
        const cookieName = flowCookieName(secure);
        const fail = (code: SsoErrorCode, detail: string, reason?: string): never => {
          logger.warn({ code, detail }, "workeasy360 sign-in failed");
          const target = new URL("/login", appUrl);
          target.searchParams.set("sso_error", code);
          if (reason && DENIAL_REASONS.has(reason)) target.searchParams.set("reason", reason);
          throw ctx.redirect(target.toString());
        };
        if (!runtime) return fail("not_configured", "WorkEasy360 sign-in is off");
        const { client, entitlements, settings } = runtime;

        // The flow is single use: taken (and its cookie dropped) before anything is checked.
        const flowId = ctx.getCookie(cookieName);
        ctx.setCookie(cookieName, "", { httpOnly: true, secure, sameSite: "lax", path: "/", maxAge: 0 });
        let flow;
        try {
          flow = flowId && /^[A-Za-z0-9_-]{43}$/.test(flowId) ? await takeLoginFlow(flowId) : undefined;
        } catch (err) {
          return fail("unavailable", describe(err));
        }
        const raw = (ctx.query ?? {}) as Record<string, unknown>;
        const query = new URLSearchParams();
        for (const name of ["code", "state", "error", "iss"]) {
          const value = raw[name];
          if (typeof value === "string") query.set(name, value.slice(0, MAX_CODE_LENGTH + 1));
        }
        if (!flow) {
          const providerError = query.get("error");
          if (providerError) return fail(PROVIDER_ERRORS[providerError] ?? "refused", `provider returned ${providerError.slice(0, 64)} without a pending flow`);
          return fail("expired", "no pending sign-in for this browser");
        }
        if (!query.get("error") && (query.get("code") ?? "").length > MAX_CODE_LENGTH) return fail("refused", "no usable code");

        let target: string;
        try {
          const identity = await client.completeLogin(query, flow);
          if (flow.organizationId && identity.organizationId !== flow.organizationId) {
            // The launcher asked for one organization and the token is for another: land nowhere.
            throw new SignInRefused("wrong_organization", "organization_id differs from the launcher's");
          }
          // Entitlement when the person arrives (integration guide §7): a denial has a message of its own.
          const access = await entitlements.check(identity.organizationId, { subject: identity.subject, fresh: true });
          if (access.status === "refused") throw new SignInRefused("access_unverified", "the provider refused this product's client");
          if (!access.allowed) throw new SignInRefused("not_entitled", `entitlement denied (${access.reason})`, access.reason);

          const outcome = await provisionSignIn({
            issuer: identity.issuer,
            subject: identity.subject,
            email: identity.email,
            name: identity.name ?? identity.email,
            organizationId: identity.organizationId,
            organizationName: identity.organizationName,
            defaultRole: settings.defaultRole,
            provisionTenants: settings.provisionTenants,
            tenantPlan: settings.tenantPlan,
          });
          if (outcome.kind === "refused") throw new SignInRefused(outcome.code, outcome.detail);

          // Account switching and session fixation: whatever session this browser held ends here.
          const presented = await ctx.getSignedCookie(ctx.context.authCookies.sessionToken.name, ctx.context.secret);
          if (presented) await ctx.context.internalAdapter.deleteSession(presented);

          const session = await ctx.context.internalAdapter.createSession(
            outcome.userId,
            false,
            {
              activeOrganizationId: outcome.tenantId,
              workeasy360Issuer: identity.issuer,
              workeasy360Subject: identity.subject,
              workeasy360Sid: identity.sid ?? null,
              workeasy360OrganizationId: identity.organizationId,
              workeasy360TenantId: outcome.tenantId,
              workeasy360IdToken: identity.idToken,
            },
            true,
          );
          const user = await ctx.context.internalAdapter.findUserById(outcome.userId);
          if (!session || !user) throw new SignInRefused("refused", "the session could not be created");
          await setSessionCookie(ctx, { session, user });
          logger.info(
            {
              userId: outcome.userId,
              tenantId: outcome.tenantId,
              sessionId: session.id,
              tenantCreated: outcome.tenantCreated,
              membershipCreated: outcome.membershipCreated,
              entitlement: access.status,
              sid: Boolean(identity.sid),
            },
            "user signed in with WorkEasy360",
          );
          target = new URL(flow.returnTo ?? "/", appUrl).toString();
        } catch (err) {
          return fail(codeForError(err), describe(err), err instanceof SignInRefused ? err.reason : undefined);
        }
        throw ctx.redirect(target);
      }),

      workeasy360SignOut: createAuthEndpoint("/workeasy360/sign-out", { method: "POST" }, async (ctx) => {
        const runtime = getWorkeasy360Runtime();
        const current = await getSessionFromCtx(ctx);
        let redirect: string | null = null;
        if (current) {
          const w360 = workeasy360Of(current.session as unknown as Record<string, unknown>);
          const idToken = w360 ? await idTokenOfSession(current.session.id) : undefined;
          // This product's session ends first, whatever WorkEasy360 then does.
          await ctx.context.internalAdapter.deleteSession(current.session.token);
          if (w360 && runtime) {
            try {
              redirect = (await runtime.client.endSessionUrl({ idTokenHint: idToken, postLogoutRedirectUri: runtime.settings.postLogoutRedirectUri }))?.toString() ?? null;
            } catch (err) {
              logger.warn({ detail: describe(err) }, "workeasy360 end_session_endpoint unavailable");
            }
          }
        }
        deleteSessionCookie(ctx);
        return ctx.json({ success: true, redirect });
      }),
    },
  } satisfies BetterAuthPlugin;
}
