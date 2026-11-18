import { describe, expect, it } from "vitest";
import { loadWorkeasy360Settings, Workeasy360ConfigError } from "../src/workeasy360/config";

const PEM = "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n";
const base = {
  WORKEASY360_ISSUER: "https://accounts.workeasy360.com",
  WORKEASY360_CLIENT_ID: "client-1",
  WORKEASY360_KEY_ID: "kid-1",
  WORKEASY360_PRIVATE_KEY_FILE: "/run/secrets/workeasy360.pem",
};
const load = (e: Record<string, string>, options: { production?: boolean; appUrl?: string } = {}) =>
  loadWorkeasy360Settings(e, { appUrl: options.appUrl ?? "https://agents.workeasy360.com", production: options.production ?? true, readKey: () => PEM });

function problemsOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    if (err instanceof Workeasy360ConfigError) return err.problems.join("\n");
    throw err;
  }
  return "";
}

describe("WorkEasy360 configuration", () => {
  it("is off without an issuer", () => {
    expect(load({})).toBeUndefined();
  });

  it("has the documented defaults", () => {
    const s = load(base)!;
    expect(s.productCode).toBe("workeasy_agents");
    expect(s.redirectUri).toBe("https://agents.workeasy360.com/api/auth/workeasy360/callback");
    expect(s.postLogoutRedirectUri).toBe("https://agents.workeasy360.com/login");
    expect(s.scopes).toEqual(["openid", "email", "profile", "organization"]);
    expect(s.ssoOnly).toBe(false);
    expect(s.defaultRole).toBe("member");
    expect(s.provisionTenants).toBe(true);
    expect(s.tenantPlan).toBe("free");
    expect(s.allowInsecureRequests).toBe(false);
  });

  it("takes a configured product code", () => {
    expect(load({ ...base, WORKEASY360_PRODUCT_CODE: "easy_agents" })!.productCode).toBe("easy_agents");
  });

  it("needs the issuer, client id, key id and key file together", () => {
    expect(problemsOf(() => load({ WORKEASY360_ISSUER: base.WORKEASY360_ISSUER }))).toMatch(/together/);
    expect(problemsOf(() => load({ WORKEASY360_CLIENT_ID: "x" }))).toMatch(/together/);
  });

  it("refuses SSO-only without WorkEasy360 sign-in", () => {
    expect(problemsOf(() => load({ WORKEASY360_SSO_ONLY: "true" }))).toMatch(/SSO_ONLY/);
  });

  it("refuses a trailing slash, plain http in production, and http to a public host", () => {
    expect(problemsOf(() => load({ ...base, WORKEASY360_ISSUER: "https://accounts.workeasy360.com/" }))).toMatch(/slash/);
    expect(problemsOf(() => load({ ...base, WORKEASY360_ISSUER: "http://127.0.0.1:8031" }))).toMatch(/https/);
    expect(problemsOf(() => load({ ...base, WORKEASY360_ISSUER: "http://accounts.example.com" }, { production: false, appUrl: "http://localhost:3000" }))).toMatch(/https/);
  });

  it("allows plain http only for a loopback provider outside production", () => {
    const s = load({ ...base, WORKEASY360_ISSUER: "http://127.0.0.1:8031" }, { production: false, appUrl: "http://localhost:3000" })!;
    expect(s.allowInsecureRequests).toBe(true);
    expect(s.redirectUri).toBe("http://localhost:3000/api/auth/workeasy360/callback");
  });

  it("refuses a redirect URI or post-logout URI elsewhere", () => {
    expect(problemsOf(() => load({ ...base, WORKEASY360_REDIRECT_URI: "https://evil.example/api/auth/workeasy360/callback" }))).toMatch(/REDIRECT_URI/);
    expect(problemsOf(() => load({ ...base, WORKEASY360_REDIRECT_URI: "https://agents.workeasy360.com/other" }))).toMatch(/REDIRECT_URI/);
    expect(problemsOf(() => load({ ...base, WORKEASY360_POST_LOGOUT_REDIRECT_URI: "https://evil.example/" }))).toMatch(/POST_LOGOUT/);
  });

  it("needs the openid and email scopes", () => {
    expect(problemsOf(() => load({ ...base, WORKEASY360_SCOPES: "openid profile" }))).toMatch(/SCOPES/);
  });

  it("refuses an unreadable or non-PEM key file", () => {
    const unreadable = () =>
      loadWorkeasy360Settings(base, {
        appUrl: "https://agents.workeasy360.com",
        production: true,
        readKey: () => {
          throw new Error("ENOENT");
        },
      });
    expect(problemsOf(unreadable)).toMatch(/cannot be read/);
    const notPem = () => loadWorkeasy360Settings(base, { appUrl: "https://agents.workeasy360.com", production: true, readKey: () => "hello" });
    expect(problemsOf(notPem)).toMatch(/PEM/);
  });

  it("refuses an unknown default role", () => {
    expect(problemsOf(() => load({ ...base, WORKEASY360_DEFAULT_ROLE: "owner" }))).toMatch(/DEFAULT_ROLE/);
  });
});
