import { readFileSync } from "node:fs";
import { z } from "zod";

/** Where WorkEasy360 sends the browser back. Registered with the provider exactly as `<APP_URL><path>`. */
export const WORKEASY360_CALLBACK_PATH = "/api/auth/workeasy360/callback";
export const WORKEASY360_START_PATH = "/api/auth/workeasy360/start";
export const WORKEASY360_BACKCHANNEL_LOGOUT_PATH = "/api/auth/workeasy360/backchannel-logout";

const ROLES = ["member", "admin"] as const;
export type Workeasy360JoinRole = (typeof ROLES)[number];

/** What the deployment's WorkEasy360 integration is, once its environment has been checked. */
export interface Workeasy360Settings {
  /** Exactly the issuer the product trusts (WORKEASY360_ISSUER): no trailing slash. */
  issuer: string;
  clientId: string;
  /** Must equal the ID token's `product_code` (WORKEASY360_PRODUCT_CODE, default `workeasy_agents`). */
  productCode: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  keyId: string;
  privateKeyPem: string;
  scopes: string[];
  /** WORKEASY360_SSO_ONLY: password and Google sign-in are off, and their sessions are refused. */
  ssoOnly: boolean;
  /** Role of someone joining an organization that already has members (WORKEASY360_DEFAULT_ROLE). */
  defaultRole: Workeasy360JoinRole;
  /** Whether an organization's first sign-in creates its Agents organization (WORKEASY360_PROVISION_TENANTS). */
  provisionTenants: boolean;
  /** Plan of an Agents organization created by a first sign-in (WORKEASY360_TENANT_PLAN). */
  tenantPlan: string;
  /** Shown on the "no access" message as the way to get the product. */
  purchaseUrl: string;
  /** The web app's origin (APP_URL): where the browser lands after signing in. */
  appUrl: string;
  /** Plain-http provider endpoints, for a loopback provider outside production only. */
  allowInsecureRequests: boolean;
}

const unsetIfEmpty = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const flag = (fallback: boolean) =>
  z.preprocess(unsetIfEmpty, z.enum(["true", "false"]).optional()).transform((v) => (v === undefined ? fallback : v === "true"));

const schema = z.object({
  WORKEASY360_ISSUER: z.preprocess(unsetIfEmpty, z.url().optional()),
  WORKEASY360_CLIENT_ID: z.preprocess(unsetIfEmpty, z.string().min(1).max(200).optional()),
  WORKEASY360_PRODUCT_CODE: z.preprocess(unsetIfEmpty, z.string().regex(/^[a-z][a-z0-9_]{1,63}$/).default("workeasy_agents")),
  WORKEASY360_REDIRECT_URI: z.preprocess(unsetIfEmpty, z.url().optional()),
  WORKEASY360_POST_LOGOUT_REDIRECT_URI: z.preprocess(unsetIfEmpty, z.url().optional()),
  WORKEASY360_KEY_ID: z.preprocess(unsetIfEmpty, z.string().min(1).max(200).optional()),
  WORKEASY360_PRIVATE_KEY_FILE: z.preprocess(unsetIfEmpty, z.string().min(1).optional()),
  WORKEASY360_SCOPES: z.preprocess(unsetIfEmpty, z.string().default("openid email profile organization")),
  WORKEASY360_SSO_ONLY: flag(false),
  WORKEASY360_DEFAULT_ROLE: z.preprocess(unsetIfEmpty, z.enum(ROLES).default("member")),
  WORKEASY360_PROVISION_TENANTS: flag(true),
  WORKEASY360_TENANT_PLAN: z.preprocess(unsetIfEmpty, z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).default("free")),
  WORKEASY360_PURCHASE_URL: z.preprocess(unsetIfEmpty, z.url().optional()),
});

function isLoopback(url: URL): boolean {
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
}

export class Workeasy360ConfigError extends Error {
  override name = "Workeasy360ConfigError";
  constructor(readonly problems: string[]) {
    super(`WorkEasy360 sign-in is misconfigured:\n- ${problems.join("\n- ")}`);
  }
}

/**
 * Reads the WORKEASY360_* environment. Returns undefined when WorkEasy360 sign-in is off (no issuer),
 * throws `Workeasy360ConfigError` naming every problem otherwise. Messages name variables, never values.
 * `readKey` is replaced in tests.
 */
export function loadWorkeasy360Settings(
  e: NodeJS.ProcessEnv,
  options: { appUrl: string; production: boolean; readKey?: (path: string) => string },
): Workeasy360Settings | undefined {
  const parsed = schema.safeParse(e);
  if (!parsed.success) {
    throw new Workeasy360ConfigError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  }
  const c = parsed.data;
  const problems: string[] = [];
  const required = [c.WORKEASY360_ISSUER, c.WORKEASY360_CLIENT_ID, c.WORKEASY360_KEY_ID, c.WORKEASY360_PRIVATE_KEY_FILE];
  if (required.some(Boolean) && !required.every(Boolean)) {
    problems.push("set WORKEASY360_ISSUER, WORKEASY360_CLIENT_ID, WORKEASY360_KEY_ID and WORKEASY360_PRIVATE_KEY_FILE together, or none of them");
  }
  if (!c.WORKEASY360_ISSUER) {
    if (c.WORKEASY360_SSO_ONLY) problems.push("WORKEASY360_SSO_ONLY needs WorkEasy360 sign-in to be configured (WORKEASY360_ISSUER)");
    if (problems.length) throw new Workeasy360ConfigError(problems);
    return undefined;
  }

  const appOrigin = new URL(options.appUrl).origin;
  const issuer = c.WORKEASY360_ISSUER;
  const issuerUrl = new URL(issuer);
  if (issuer.endsWith("/")) problems.push("WORKEASY360_ISSUER must not end with a slash (it must equal the provider's issuer exactly)");
  const httpAllowed = !options.production && isLoopback(issuerUrl);
  if (issuerUrl.protocol !== "https:" && !(issuerUrl.protocol === "http:" && httpAllowed)) {
    problems.push("WORKEASY360_ISSUER must use https (plain http only for a loopback provider outside production)");
  }
  if (issuerUrl.search || issuerUrl.hash) problems.push("WORKEASY360_ISSUER must not have a query or fragment");

  const redirectUri = c.WORKEASY360_REDIRECT_URI ?? `${appOrigin}${WORKEASY360_CALLBACK_PATH}`;
  const redirect = new URL(redirectUri);
  if (redirect.origin !== appOrigin || redirect.pathname !== WORKEASY360_CALLBACK_PATH || redirect.search || redirect.hash) {
    problems.push(`WORKEASY360_REDIRECT_URI must be ${appOrigin}${WORKEASY360_CALLBACK_PATH}`);
  }
  const postLogoutRedirectUri = c.WORKEASY360_POST_LOGOUT_REDIRECT_URI ?? `${appOrigin}/login`;
  if (new URL(postLogoutRedirectUri).origin !== appOrigin) problems.push("WORKEASY360_POST_LOGOUT_REDIRECT_URI must be on the APP_URL origin");

  const scopes = c.WORKEASY360_SCOPES.split(/\s+/).filter(Boolean);
  // email_verified comes with the email scope, and the contract refuses a token without it.
  if (!scopes.includes("openid") || !scopes.includes("email")) problems.push("WORKEASY360_SCOPES must include openid and email");

  let privateKeyPem = "";
  try {
    privateKeyPem = (options.readKey ?? ((p) => readFileSync(p, "utf8")))(c.WORKEASY360_PRIVATE_KEY_FILE!);
    if (!privateKeyPem.includes("PRIVATE KEY")) problems.push("WORKEASY360_PRIVATE_KEY_FILE does not hold a PEM private key");
  } catch {
    problems.push("WORKEASY360_PRIVATE_KEY_FILE cannot be read");
  }
  if (problems.length) throw new Workeasy360ConfigError(problems);

  return {
    issuer,
    clientId: c.WORKEASY360_CLIENT_ID!,
    productCode: c.WORKEASY360_PRODUCT_CODE,
    redirectUri,
    postLogoutRedirectUri,
    keyId: c.WORKEASY360_KEY_ID!,
    privateKeyPem,
    scopes,
    ssoOnly: c.WORKEASY360_SSO_ONLY,
    defaultRole: c.WORKEASY360_DEFAULT_ROLE,
    provisionTenants: c.WORKEASY360_PROVISION_TENANTS,
    tenantPlan: c.WORKEASY360_TENANT_PLAN,
    purchaseUrl: c.WORKEASY360_PURCHASE_URL ?? issuer,
    appUrl: appOrigin,
    allowInsecureRequests: issuerUrl.protocol === "http:" && httpAllowed,
  };
}
