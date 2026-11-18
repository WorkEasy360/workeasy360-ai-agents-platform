/**
 * Sign-in with WorkEasy360 Accounts (docs/workeasy360-sso.md), end to end against a fake provider
 * (workeasy360-fake-provider.ts: discovery, key set, authorize, token with private_key_jwt + PKCE checks,
 * entitlement and end-session; keys generated when it starts).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { adminDb, closeDb } from "@we360/db";
import { account, member, organization, session, twoFactor, user, workeasy360Entitlements, workeasy360Identities, workeasy360LoginFlows, workeasy360Organizations } from "@we360/db/schema";
import { createApp } from "../src/app";
import { auth } from "../src/auth/auth";
import { env } from "../src/config/env";
import { closeQueues, getEmailQueue, redis } from "../src/lib/queue";
import type { Workeasy360Settings } from "../src/workeasy360/config";
import { createWorkeasy360Runtime, setWorkeasy360Runtime } from "../src/workeasy360/runtime";
import { linkOrganization, linkUser, moveIssuer } from "../src/workeasy360/store";
import { ORIGIN, signUpWithOrg } from "./helpers";
import { FakeWorkeasy360, type ClientKeys, type FakePerson, type IdTokenTampering } from "./workeasy360-fake-provider";

const CLIENT_ID = "workeasy-agents-test";
const REDIRECT_URI = `${ORIGIN}/api/auth/workeasy360/callback`;
const SESSION_COOKIE = "better-auth.session_token";
const ALLOW = (organizationId: string) => ({
  status: 200,
  body: { decision: "allow", reason: "entitled", product_code: "workeasy_agents", organization_id: organizationId, write_allowed: true, revalidate_after: 900 },
});

let fake: FakeWorkeasy360;
let keys: ClientKeys;
let settings: Workeasy360Settings;
let app: ReturnType<typeof createApp>;
/** Added to the entitlement cache's clock, to let a cached answer go stale. */
let clock = 0;

const createdUsers = new Set<string>();
const createdOrgs = new Set<string>();
const personOrganizations = new Set<string>();

/** A fresh runtime (and so a fresh entitlement cache) for this process; `overrides` change the settings. */
function useRuntime(overrides: Partial<Workeasy360Settings> = {}) {
  setWorkeasy360Runtime(createWorkeasy360Runtime({ ...settings, ...overrides }, { cacheNow: () => Date.now() + clock }));
}

beforeAll(async () => {
  fake = await FakeWorkeasy360.start();
  keys = await fake.registerClient(CLIENT_ID, [REDIRECT_URI]);
  settings = {
    issuer: fake.issuer,
    clientId: CLIENT_ID,
    productCode: "workeasy_agents",
    redirectUri: REDIRECT_URI,
    postLogoutRedirectUri: `${ORIGIN}/login`,
    keyId: keys.keyId,
    privateKeyPem: keys.privateKeyPem,
    scopes: ["openid", "email", "profile", "organization"],
    ssoOnly: false,
    defaultRole: "member",
    provisionTenants: true,
    tenantPlan: "free",
    purchaseUrl: fake.issuer,
    appUrl: ORIGIN,
    allowInsecureRequests: true,
  };
  app = createApp({ workeasy360: createWorkeasy360Runtime(settings, { cacheNow: () => Date.now() + clock }) });
});

afterAll(async () => {
  const db = adminDb();
  // Everything this file's provider created, even by sign-ins that were refused half-way.
  for (const row of await db.select({ userId: workeasy360Identities.userId }).from(workeasy360Identities).where(eq(workeasy360Identities.issuer, fake.issuer))) createdUsers.add(row.userId);
  if (personOrganizations.size) {
    for (const row of await db.select({ tenantId: workeasy360Organizations.tenantId }).from(workeasy360Organizations).where(inArray(workeasy360Organizations.organizationId, [...personOrganizations]))) createdOrgs.add(row.tenantId);
  }
  if (createdOrgs.size) await db.delete(organization).where(inArray(organization.id, [...createdOrgs]));
  if (createdUsers.size) await db.delete(user).where(inArray(user.id, [...createdUsers]));
  await db.delete(workeasy360Entitlements).where(sql`true`);
  await fake?.stop();
  await closeQueues();
  await closeDb();
});

function newPerson(overrides: Partial<FakePerson> = {}): FakePerson {
  const tag = randomUUID().slice(0, 8);
  const organizationId = "organizationId" in overrides ? overrides.organizationId : randomUUID();
  if (organizationId) personOrganizations.add(organizationId);
  return {
    sub: randomUUID(),
    email: `w360-${tag}@test.local`,
    emailVerified: true,
    name: `Person ${tag}`,
    organizationId,
    organizationName: `Org ${tag}`,
    sid: randomUUID(),
    ...overrides,
  };
}

function cookieFrom(res: request.Response, name: string): string | undefined {
  const raw = res.headers["set-cookie"] as unknown as string[] | string | undefined;
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const entry = list.find((c) => c.startsWith(`${name}=`));
  return entry ? entry.split(";")[0] : undefined;
}

type Agent = ReturnType<typeof request.agent>;

/**
 * The browser's whole round trip: /start on the app, the provider's authorize endpoint, /callback on the
 * app. `organization` is the launcher's hint (default: the person's organization; null: none).
 */
async function signIn(
  person: FakePerson,
  options: { agent?: Agent; organization?: string | null; tampering?: IdTokenTampering; beforeCallback?: () => Promise<void> } = {},
) {
  const agent = options.agent ?? request.agent(app);
  fake.person = person;
  if (options.tampering) fake.tampering = options.tampering;
  const hint = options.organization === undefined ? person.organizationId : options.organization;
  const start = await agent.get(`/api/auth/workeasy360/start${hint ? `?organization=${hint}` : ""}`);
  expect(start.status).toBe(302);
  const authorize = new URL(start.headers.location as string);
  const provider = await fetch(authorize, { redirect: "manual" });
  expect(provider.status).toBe(302);
  const back = new URL(provider.headers.get("location")!);
  await options.beforeCallback?.();
  const callback = await agent.get(back.pathname + back.search);
  expect(callback.status).toBe(302);
  const location = new URL(callback.headers.location as string, ORIGIN);
  const cookie = cookieFrom(callback, SESSION_COOKIE);
  let tenantId: string | undefined;
  if (!location.searchParams.get("sso_error")) {
    const me = await agent.get("/api/v1/me");
    tenantId = me.body.activeOrganizationId;
    if (me.body.user?.id) createdUsers.add(me.body.user.id);
    if (tenantId) createdOrgs.add(tenantId);
  }
  return { agent, start, authorize, callback, location, cookie, tenantId, ssoError: location.searchParams.get("sso_error"), reason: location.searchParams.get("reason") };
}

async function liveSessionsOf(person: FakePerson): Promise<number> {
  const rows = await adminDb().select({ id: session.id }).from(session).where(and(eq(session.workeasy360Issuer, fake.issuer), eq(session.workeasy360Subject, person.sub)));
  return rows.length;
}

const backchannel = (token: string) => request(app).post("/api/auth/workeasy360/backchannel-logout").type("form").send({ logout_token: token });

describe("sign-in: the happy path", () => {
  it("signs a person in with code + PKCE S256 + private_key_jwt and opens a session bound to their organization", async () => {
    const person = newPerson();
    const seenToken = fake.seen.token.length;
    const r = await signIn(person);
    expect(r.ssoError).toBeNull();
    expect(r.location.pathname).toBe("/");
    expect(r.cookie).toBeDefined();

    // The authorization request: code flow, PKCE S256, state, nonce, the launcher's organization.
    const q = r.authorize.searchParams;
    expect(q.get("response_type")).toBe("code");
    expect(q.get("client_id")).toBe(CLIENT_ID);
    expect(q.get("redirect_uri")).toBe(REDIRECT_URI);
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("state")).toBeTruthy();
    expect(q.get("nonce")).toBeTruthy();
    expect(q.get("organization")).toBe(person.organizationId);
    expect(q.get("scope")).toBe("openid email profile organization");

    // The code exchange: a client assertion with iss = sub = client id and aud = the token endpoint.
    const exchange = fake.seen.token.at(-1)!;
    expect(fake.seen.token.length).toBe(seenToken + 1);
    expect(exchange.assertion.iss).toBe(CLIENT_ID);
    expect(exchange.assertion.sub).toBe(CLIENT_ID);
    expect(exchange.assertion.aud).toBe(fake.tokenEndpoint);
    expect(exchange.form.get("client_assertion_type")).toBe("urn:ietf:params:oauth:client-assertion-type:jwt-bearer");
    expect(exchange.form.get("client_secret")).toBeNull();
    expect(exchange.form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);

    // The entitlement question, for the organization and the person, with its own client assertion.
    const asked = fake.seen.entitlement.at(-1)!;
    expect(asked.form.get("organization_id")).toBe(person.organizationId);
    expect(asked.form.get("subject")).toBe(person.sub);
    expect(asked.form.get("product_code")).toBeNull();
    expect(asked.assertion.aud).toBe(fake.tokenEndpoint);

    // The person, linked on (issuer, sub); a new organization with its owner; a session on it.
    const me = await r.agent.get("/api/v1/me");
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(person.email);
    expect(me.body.user.emailVerified).toBe(true);
    expect(me.body.signedInWith).toBe("workeasy360");
    expect(me.body.organizations).toHaveLength(1);
    expect(me.body.organizations[0]).toMatchObject({ id: r.tenantId, name: person.organizationName, role: "owner", planKey: "free" });
    const [identity] = await adminDb().select().from(workeasy360Identities).where(and(eq(workeasy360Identities.issuer, fake.issuer), eq(workeasy360Identities.subject, person.sub)));
    expect(identity?.userId).toBe(me.body.user.id);
    const [link] = await adminDb().select().from(workeasy360Organizations).where(eq(workeasy360Organizations.organizationId, person.organizationId!));
    expect(link?.tenantId).toBe(r.tenantId);
    const [row] = await adminDb().select().from(session).where(eq(session.userId, me.body.user.id));
    expect(row).toMatchObject({ workeasy360Issuer: fake.issuer, workeasy360Subject: person.sub, workeasy360Sid: person.sid, workeasy360OrganizationId: person.organizationId, workeasy360TenantId: r.tenantId, activeOrganizationId: r.tenantId });

    // Existing routes work unchanged: the default workspace exists, and the owner can create an agent.
    const workspaces = await r.agent.get("/api/v1/workspaces").set("x-org-id", r.tenantId!);
    expect(workspaces.status).toBe(200);
    expect(workspaces.body.data).toHaveLength(1);
    const created = await r.agent.post("/api/v1/agents").set("Origin", ORIGIN).set("x-org-id", r.tenantId!).send({ name: "Helper" });
    expect(created.status).toBe(201);

    // The session the browser gets is never told the ID token.
    const got = await r.agent.get("/api/auth/get-session");
    expect(got.status).toBe(200);
    expect(JSON.stringify(got.body)).not.toContain("workeasy360IdToken");
  });

  it("signs the same person in again into the same user and organization, as a member when others joined first", async () => {
    const owner = newPerson();
    const first = await signIn(owner);
    const again = await signIn(owner);
    expect(again.tenantId).toBe(first.tenantId);
    const colleague = newPerson({ organizationId: owner.organizationId, organizationName: owner.organizationName });
    const joined = await signIn(colleague);
    expect(joined.tenantId).toBe(first.tenantId);
    const me = await joined.agent.get("/api/v1/me");
    expect(me.body.organizations[0].role).toBe("member");
  });

  it("starts without an organization hint and lands in the organization the provider chose", async () => {
    const person = newPerson();
    const r = await signIn(person, { organization: null });
    expect(r.authorize.searchParams.get("organization")).toBeNull();
    expect(r.ssoError).toBeNull();
    expect(r.tenantId).toBeDefined();
  });

  it("keeps the session's state server-side: the flow cookie is httpOnly and the flow is used once", async () => {
    const person = newPerson();
    const agent = request.agent(app);
    fake.person = person;
    const start = await agent.get(`/api/auth/workeasy360/start?organization=${person.organizationId}`);
    const flowCookie = (start.headers["set-cookie"] as unknown as string[]).find((c) => c.startsWith("we360_w360_flow="))!;
    expect(flowCookie).toMatch(/HttpOnly/i);
    expect(flowCookie).toMatch(/SameSite=Lax/i);
    const provider = await fetch(start.headers.location as string, { redirect: "manual" });
    const back = new URL(provider.headers.get("location")!);
    const first = await agent.get(back.pathname + back.search);
    expect(new URL(first.headers.location as string, ORIGIN).searchParams.get("sso_error")).toBeNull();
    const me = await agent.get("/api/v1/me");
    createdUsers.add(me.body.user.id);
    createdOrgs.add(me.body.activeOrganizationId);
    // Replaying the same callback (same code, same state) in another browser: no flow there.
    const replay = await request(app).get(back.pathname + back.search).set("Cookie", flowCookie.split(";")[0]!);
    expect(new URL(replay.headers.location as string, ORIGIN).searchParams.get("sso_error")).toBe("expired");
  });
});

describe("sign-in: every check of the ID token", () => {
  const refused = async (tampering: IdTokenTampering, expected: string) => {
    const person = newPerson();
    const r = await signIn(person, { tampering });
    expect(r.ssoError).toBe(expected);
    expect(r.cookie).toBeUndefined();
    expect(await liveSessionsOf(person)).toBe(0);
    expect((await r.agent.get("/api/v1/me")).status).toBe(401);
  };

  it("refuses a token from another issuer", () => refused({ issuer: "https://evil.example" }, "invalid_token"));
  it("refuses a token for another audience", () => refused({ audience: "another-product" }, "invalid_token"));
  it("refuses a token signed by a key outside the key set", () => refused({ foreignKey: true }, "invalid_token"));
  it("refuses a token answering another request (nonce)", () => refused({ nonce: "not-this-browsers" }, "invalid_token"));
  it("refuses an access token presented as an ID token (typ)", () => refused({ typ: "at+jwt" }, "invalid_token"));
  it("refuses a token for another product", () => refused({ productCode: "easy_crm" }, "wrong_product"));

  it("refuses a token without an organization", async () => {
    const person = newPerson({ organizationId: undefined });
    const r = await signIn(person, { organization: null });
    expect(r.ssoError).toBe("no_organization");
    expect(await liveSessionsOf(person)).toBe(0);
  });

  it("refuses an unverified email address", async () => {
    const person = newPerson({ emailVerified: false });
    const r = await signIn(person);
    expect(r.ssoError).toBe("email_unverified");
    expect(await liveSessionsOf(person)).toBe(0);
  });

  it("refuses a token for another organization than the launcher asked for", async () => {
    const person = newPerson();
    const r = await signIn(person, { tampering: { claims: { organization_id: randomUUID() } } });
    expect(r.ssoError).toBe("wrong_organization");
    expect(await liveSessionsOf(person)).toBe(0);
  });
});

describe("sign-in: PKCE and state", () => {
  it("never asks without an S256 challenge, and the provider refuses a request that lacks one", async () => {
    const start = await request(app).get("/api/auth/workeasy360/start");
    const url = new URL(start.headers.location as string);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    url.searchParams.delete("code_challenge");
    url.searchParams.delete("code_challenge_method");
    const provider = await fetch(url, { redirect: "manual" });
    expect(new URL(provider.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
  });

  it("refuses the sign-in when the code is exchanged without the verifier it was issued for", async () => {
    const person = newPerson();
    const r = await signIn(person, {
      // The flow's verifier replaced before the callback: the token endpoint answers invalid_grant.
      beforeCallback: async () => {
        await adminDb().update(workeasy360LoginFlows).set({ codeVerifier: "x".repeat(64) }).where(sql`true`);
      },
    });
    expect(r.ssoError).toBe("expired");
    expect(await liveSessionsOf(person)).toBe(0);
  });

  it("refuses a callback whose state is not this browser's", async () => {
    const person = newPerson();
    const agent = request.agent(app);
    fake.person = person;
    const start = await agent.get("/api/auth/workeasy360/start");
    const provider = await fetch(start.headers.location as string, { redirect: "manual" });
    const back = new URL(provider.headers.get("location")!);
    back.searchParams.set("state", "forged-state");
    const callback = await agent.get(back.pathname + back.search);
    expect(new URL(callback.headers.location as string, ORIGIN).searchParams.get("sso_error")).toBe("expired");
    expect(await liveSessionsOf(person)).toBe(0);
  });

  it("shows the provider's refusal (the person cancelled)", async () => {
    const person = newPerson();
    fake.authorizeError = "access_denied";
    const agent = request.agent(app);
    fake.person = person;
    const start = await agent.get("/api/auth/workeasy360/start");
    const provider = await fetch(start.headers.location as string, { redirect: "manual" });
    const back = new URL(provider.headers.get("location")!);
    const callback = await agent.get(back.pathname + back.search);
    expect(new URL(callback.headers.location as string, ORIGIN).searchParams.get("sso_error")).toBe("cancelled");
  });
});

describe("entitlement", () => {
  it("refuses a sign-in for an organization that is not entitled, with the reason", async () => {
    const person = newPerson();
    fake.entitlement = (org) => (org === person.organizationId ? { status: 200, body: { decision: "deny", reason: "not_entitled", revalidate_after: 900 } } : ALLOW(org));
    try {
      const r = await signIn(person);
      expect(r.ssoError).toBe("not_entitled");
      expect(r.reason).toBe("not_entitled");
      expect(await liveSessionsOf(person)).toBe(0);
      const [link] = await adminDb().select().from(workeasy360Organizations).where(eq(workeasy360Organizations.organizationId, person.organizationId!));
      expect(link).toBeUndefined();
    } finally {
      fake.entitlement = ALLOW;
    }
  });

  it("re-checks on the platform's cadence: a denial ends access, read-only refuses writes, an outage keeps the last answer", async () => {
    const person = newPerson();
    const r = await signIn(person);
    const asked = () => fake.seen.entitlement.filter((e) => e.form.get("organization_id") === person.organizationId).length;
    const before = asked();
    // Within revalidate_after nothing is asked.
    expect((await r.agent.get("/api/v1/workspaces").set("x-org-id", r.tenantId!)).status).toBe(200);
    expect(asked()).toBe(before);

    try {
      // Read-only (a suspended subscription): reads work, writes are refused.
      fake.entitlement = (org) => ({ status: 200, body: { ...ALLOW(org).body, write_allowed: false } });
      clock += 901_000;
      expect((await r.agent.get("/api/v1/workspaces").set("x-org-id", r.tenantId!)).status).toBe(200);
      expect(asked()).toBe(before + 1);
      const write = await r.agent.post("/api/v1/agents").set("Origin", ORIGIN).set("x-org-id", r.tenantId!).send({ name: "x" });
      expect([write.status, write.body.code]).toEqual([403, "workeasy360_read_only"]);

      // An outage is never a denial: the last answer stands.
      fake.entitlement = () => ({ status: 503, body: { error: "temporarily_unavailable" } });
      clock += 901_000;
      expect((await r.agent.get("/api/v1/workspaces").set("x-org-id", r.tenantId!)).status).toBe(200);

      // A denial ends access to the organization; the session itself stays, so the page can say why.
      fake.entitlement = (org) => ({ status: 200, body: { decision: "deny", reason: "expired", revalidate_after: 900 } });
      clock += 901_000;
      const ended = await r.agent.get("/api/v1/workspaces").set("x-org-id", r.tenantId!);
      expect([ended.status, ended.body.code, ended.body.errors?.reason]).toEqual([403, "workeasy360_access_ended", "expired"]);
      expect((await r.agent.get("/api/v1/me")).status).toBe(200);

      // A known denial survives an outage.
      fake.entitlement = () => ({ status: 500, body: {} });
      clock += 61_000;
      expect((await r.agent.get("/api/v1/workspaces").set("x-org-id", r.tenantId!)).body.code).toBe("workeasy360_access_ended");

      // A renewal is seen after a minute.
      fake.entitlement = ALLOW;
      clock += 61_000;
      expect((await r.agent.get("/api/v1/workspaces").set("x-org-id", r.tenantId!)).status).toBe(200);
    } finally {
      fake.entitlement = ALLOW;
    }
  });

  it("removes a person whose WorkEasy360 membership ended (subject), within one window", async () => {
    const person = newPerson();
    const r = await signIn(person);
    try {
      fake.entitlement = (org, subject) => (subject === person.sub ? { status: 200, body: { decision: "deny", reason: "membership_inactive", revalidate_after: 900 } } : ALLOW(org));
      clock += 901_000;
      const res = await r.agent.get("/api/v1/workspaces").set("x-org-id", r.tenantId!);
      expect([res.status, res.body.errors?.reason]).toEqual([403, "membership_inactive"]);
    } finally {
      fake.entitlement = ALLOW;
    }
  });

  it("fails closed for the whole client when the platform refuses this product's credential", async () => {
    const person = newPerson();
    const r = await signIn(person);
    useRuntime();
    try {
      fake.entitlement = () => ({ status: 401, body: { error: "invalid_client" } });
      clock += 901_000;
      const res = await r.agent.get("/api/v1/workspaces").set("x-org-id", r.tenantId!);
      expect([res.status, res.body.code]).toEqual([403, "workeasy360_access_unverified"]);
      // A sign-in is refused too, and nothing is created.
      const other = newPerson();
      const refused = await signIn(other);
      expect(refused.ssoError).toBe("access_unverified");
      expect(await liveSessionsOf(other)).toBe(0);
    } finally {
      fake.entitlement = ALLOW;
      await adminDb().delete(workeasy360Entitlements).where(eq(workeasy360Entitlements.key, "w360:client-refused"));
      useRuntime();
    }
  });

  it("applies to the organization's API keys too", async () => {
    const person = newPerson();
    const r = await signIn(person);
    const key = await r.agent.post("/api/v1/api-keys").set("Origin", ORIGIN).set("x-org-id", r.tenantId!).send({ name: "ci" });
    expect(key.status).toBe(201);
    const secret = key.body.secret ?? key.body.key;
    expect(secret).toMatch(/^we360_sk_/);
    try {
      fake.entitlement = (org) => (org === person.organizationId ? { status: 200, body: { decision: "deny", reason: "suspended", revalidate_after: 900 } } : ALLOW(org));
      clock += 901_000;
      const run = await request(app).get(`/api/v1/runs/${randomUUID()}`).set("Authorization", `Bearer ${secret}`);
      expect([run.status, run.body.code]).toEqual([403, "workeasy360_access_ended"]);
    } finally {
      fake.entitlement = ALLOW;
    }
  });
});

describe("organizations: a WorkEasy360 session never crosses into another one", () => {
  it("refuses another organization, even one the same person belongs to", async () => {
    const person = newPerson();
    const inA = await signIn(person);
    const secondOrg = randomUUID();
    personOrganizations.add(secondOrg);
    const inB = await signIn({ ...person, organizationId: secondOrg, organizationName: "Second" });
    expect(inB.tenantId).not.toBe(inA.tenantId);

    // Session B, organization A: not found, as for a non-member.
    const cross = await inB.agent.get("/api/v1/workspaces").set("x-org-id", inA.tenantId!);
    expect(cross.status).toBe(404);
    const crossWrite = await inB.agent.post("/api/v1/agents").set("Origin", ORIGIN).set("x-org-id", inA.tenantId!).send({ name: "x" });
    expect(crossWrite.status).toBe(404);
    // /me lists only the session's own organization.
    const me = await inB.agent.get("/api/v1/me");
    expect(me.body.organizations.map((o: { id: string }) => o.id)).toEqual([inB.tenantId]);
    // Better Auth's organization endpoints: no switching, creating, deleting or reading another one.
    const setActive = await inB.agent.post("/api/auth/organization/set-active").set("Origin", ORIGIN).send({ organizationId: inA.tenantId });
    expect(setActive.status).toBe(403);
    const full = await inB.agent.get(`/api/auth/organization/get-full-organization?organizationId=${inA.tenantId}`);
    expect(full.status).toBe(403);
    const create = await inB.agent.post("/api/auth/organization/create").set("Origin", ORIGIN).send({ name: "Mine", slug: `mine-${randomUUID().slice(0, 8)}` });
    expect(create.status).toBe(403);
    const remove = await inB.agent.post("/api/auth/organization/delete").set("Origin", ORIGIN).send({ organizationId: inB.tenantId });
    expect(remove.status).toBe(403);
    // Its own organization still works through Better Auth.
    const own = await inB.agent.get(`/api/auth/organization/get-full-organization?organizationId=${inB.tenantId}`);
    expect(own.status).toBe(200);
  });

  it("refuses an organization of somebody else entirely", async () => {
    const local = await signUpWithOrg("w360-local");
    createdUsers.add(local.userId);
    createdOrgs.add(local.orgId);
    const r = await signIn(newPerson());
    expect((await r.agent.get("/api/v1/workspaces").set("x-org-id", local.orgId)).status).toBe(404);
  });

  it("does not create an organization when WORKEASY360_PROVISION_TENANTS=false", async () => {
    useRuntime({ provisionTenants: false });
    try {
      const person = newPerson();
      const r = await signIn(person);
      expect(r.ssoError).toBe("no_tenant");
      expect(await liveSessionsOf(person)).toBe(0);
    } finally {
      useRuntime();
    }
  });
});

describe("back-channel logout", () => {
  it("ends the sessions of a sign-in (sid) at once, and answers a duplicate with 200", async () => {
    const person = newPerson();
    const one = await signIn(person);
    const other = await signIn({ ...person, sid: randomUUID() });
    expect((await one.agent.get("/api/v1/me")).status).toBe(200);
    const token = await fake.logoutToken(CLIENT_ID, { sub: person.sub, sid: person.sid });
    expect((await backchannel(token)).status).toBe(200);
    expect((await one.agent.get("/api/v1/me")).status).toBe(401);
    // Another sign-in of the same person (another sid) is untouched.
    expect((await other.agent.get("/api/v1/me")).status).toBe(200);
    // At-least-once delivery: the same token again is a success that changes nothing.
    expect((await backchannel(token)).status).toBe(200);
    expect((await other.agent.get("/api/v1/me")).status).toBe(200);
  });

  it("ends every session of a person when the token names only sub", async () => {
    const person = newPerson();
    const one = await signIn(person);
    const two = await signIn({ ...person, sid: randomUUID() });
    const token = await fake.logoutToken(CLIENT_ID, { sub: person.sub });
    expect((await backchannel(token)).status).toBe(200);
    expect((await one.agent.get("/api/v1/me")).status).toBe(401);
    expect((await two.agent.get("/api/v1/me")).status).toBe(401);
    expect(await liveSessionsOf(person)).toBe(0);
  });

  it("ignores a replayed jti: a new session is not ended by an old token", async () => {
    const person = newPerson();
    await signIn(person);
    const jti = randomUUID();
    const token = await fake.logoutToken(CLIENT_ID, { sub: person.sub, jti });
    expect((await backchannel(token)).status).toBe(200);
    const again = await signIn(person);
    expect((await backchannel(token)).status).toBe(200);
    // Even re-signed with the same jti.
    expect((await backchannel(await fake.logoutToken(CLIENT_ID, { sub: person.sub, jti }))).status).toBe(200);
    expect((await again.agent.get("/api/v1/me")).status).toBe(200);
  });

  describe("refuses forged logout tokens with 400 and ends nothing", () => {
    const forged: Array<[string, (person: FakePerson) => Promise<string>]> = [
      ["signed by another key", (p) => fake.logoutToken(CLIENT_ID, { sub: p.sub, foreignKey: true })],
      ["from another issuer", (p) => fake.logoutToken(CLIENT_ID, { sub: p.sub, issuer: "https://evil.example" })],
      ["for another audience", (p) => fake.logoutToken(CLIENT_ID, { sub: p.sub, audience: "another-product" })],
      ["with the wrong typ", (p) => fake.logoutToken(CLIENT_ID, { sub: p.sub, typ: "JWT" })],
      ["without the back-channel logout event", (p) => fake.logoutToken(CLIENT_ID, { sub: p.sub, withoutEvent: true })],
      ["carrying a nonce", (p) => fake.logoutToken(CLIENT_ID, { sub: p.sub, nonce: "n" })],
      ["naming neither sub nor sid", () => fake.logoutToken(CLIENT_ID, {})],
      ["too old", (p) => fake.logoutToken(CLIENT_ID, { sub: p.sub, issuedAt: Math.floor(Date.now() / 1000) - 3600 })],
    ];
    it.each(forged)("%s", async (_label, make) => {
      const person = newPerson();
      const r = await signIn(person);
      const res = await backchannel(await make(person));
      expect([res.status, res.body.error]).toEqual([400, "invalid_request"]);
      expect((await r.agent.get("/api/v1/me")).status).toBe(200);
    });

    it("an ID token presented as a logout token", async () => {
      const person = newPerson();
      const r = await signIn(person);
      const idToken = await fake.signIdToken(CLIENT_ID, { sub: person.sub, typ: "id_token", nonce: "n", events: { "http://schemas.openid.net/event/backchannel-logout": {} } });
      expect((await backchannel(idToken)).status).toBe(400);
      expect((await r.agent.get("/api/v1/me")).status).toBe(200);
    });

    it("no logout_token at all", async () => {
      expect((await request(app).post("/api/auth/workeasy360/backchannel-logout").type("form").send({})).status).toBe(400);
      expect((await request(app).post("/api/auth/workeasy360/backchannel-logout").send({ logout_token: "x" })).status).toBe(400);
    });
  });
});

describe("two API instances sharing the database", () => {
  let child: ChildProcess | undefined;
  let port = 0;
  let keyDir = "";
  let output = "";

  beforeAll(async () => {
    port = await new Promise<number>((resolve) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const p = (probe.address() as { port: number }).port;
        probe.close(() => resolve(p));
      });
    });
    keyDir = mkdtempSync(join(tmpdir(), "w360-agents-"));
    const keyFile = join(keyDir, "client.pem");
    writeFileSync(keyFile, keys.privateKeyPem, { mode: 0o600 });
    const tsx = createRequire(import.meta.url).resolve("tsx/cli");
    child = spawn(process.execPath, [tsx, "src/server.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        API_PORT: String(port),
        LOG_LEVEL: "warn",
        DB_POOL_MAX: "2",
        DB_ADMIN_POOL_MAX: "1",
        WORKEASY360_ISSUER: fake.issuer,
        WORKEASY360_CLIENT_ID: CLIENT_ID,
        WORKEASY360_KEY_ID: keys.keyId,
        WORKEASY360_PRIVATE_KEY_FILE: keyFile,
        WORKEASY360_REDIRECT_URI: REDIRECT_URI,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (d) => (output += String(d)));
    child.stderr?.on("data", (d) => (output += String(d)));
    const deadline = Date.now() + 120_000;
    for (;;) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (res.status === 200) break;
      } catch {
        // not up yet
      }
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`second instance did not start:\n${output}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  }, 150_000);

  afterAll(() => {
    child?.kill();
    if (keyDir) rmSync(keyDir, { recursive: true, force: true });
  });

  const onB = (path: string, cookie: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, { ...init, headers: { cookie, ...(init.headers as Record<string, string> | undefined) } });

  it("refuses a session on both instances as soon as either one receives the logout token", async () => {
    // Instance B answers with its own configuration (read from the environment).
    const config = await (await fetch(`http://127.0.0.1:${port}/api/public/v1/platform`)).json();
    expect(config).toMatchObject({ workeasy360: true, ssoOnly: false });

    for (const receiver of ["A", "B"] as const) {
      const person = newPerson();
      const r = await signIn(person);
      const cookie = r.cookie!;
      expect((await r.agent.get("/api/v1/me")).status).toBe(200);
      expect((await onB("/api/v1/me", cookie)).status).toBe(200);
      expect((await onB("/api/v1/workspaces", cookie, { headers: { "x-org-id": r.tenantId! } })).status).toBe(200);

      const token = await fake.logoutToken(CLIENT_ID, { sub: person.sub, sid: person.sid });
      const delivered =
        receiver === "A"
          ? (await backchannel(token)).status
          : (await fetch(`http://127.0.0.1:${port}/api/auth/workeasy360/backchannel-logout`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ logout_token: token }) })).status;
      expect(delivered).toBe(200);

      // Immediately, on both: no cache anywhere keeps the session alive.
      expect((await r.agent.get("/api/v1/me")).status).toBe(401);
      expect((await onB("/api/v1/me", cookie)).status).toBe(401);
      expect((await onB("/api/v1/workspaces", cookie, { headers: { "x-org-id": r.tenantId! } })).status).toBe(401);
      expect((await onB("/api/auth/get-session", cookie)).status).toBe(200);
      expect(await (await onB("/api/auth/get-session", cookie)).json()).toBeNull();
    }
  });

  it("has no cookie cache that could outlive a revoked session", async () => {
    expect(auth.options.session?.cookieCache?.enabled).toBe(false);
    const r = await signIn(newPerson());
    expect(cookieFrom(r.callback, "better-auth.session_data")).toBeUndefined();
  });
});

describe("signing out", () => {
  it("product sign-out ends this product's session only", async () => {
    const person = newPerson();
    const r = await signIn(person);
    const ended = fake.seen.endSession.length;
    const out = await r.agent.post("/api/auth/sign-out").set("Origin", ORIGIN).send({});
    expect(out.status).toBe(200);
    expect((await r.agent.get("/api/v1/me")).status).toBe(401);
    expect(fake.seen.endSession.length).toBe(ended);
  });

  it("'sign out of WorkEasy360 too' ends the session, then sends the browser to end_session_endpoint with id_token_hint", async () => {
    const person = newPerson();
    const r = await signIn(person);
    const [row] = await adminDb().select({ idToken: session.workeasy360IdToken }).from(session).where(eq(session.workeasy360Subject, person.sub));
    const out = await r.agent.post("/api/auth/workeasy360/sign-out").set("Origin", ORIGIN).send({});
    expect(out.status).toBe(200);
    const target = new URL(out.body.redirect);
    expect(`${target.origin}${target.pathname}`).toBe(`${fake.issuer}/api/v1/integrations/oauth/logout`);
    expect(target.searchParams.get("id_token_hint")).toBe(row!.idToken);
    expect(target.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(target.searchParams.get("post_logout_redirect_uri")).toBe(`${ORIGIN}/login`);
    expect((await r.agent.get("/api/v1/me")).status).toBe(401);
    expect(await liveSessionsOf(person)).toBe(0);
  });

  it("'sign out of WorkEasy360 too' from a password session just signs out", async () => {
    const local = await signUpWithOrg("w360-signout");
    createdUsers.add(local.userId);
    createdOrgs.add(local.orgId);
    const out = await local.agent.post("/api/auth/workeasy360/sign-out").set("Origin", ORIGIN).send({});
    expect([out.status, out.body.redirect]).toEqual([200, null]);
    expect((await local.agent.get("/api/v1/me")).status).toBe(401);
  });
});

describe("existing accounts are never merged by email", () => {
  it("refuses a WorkEasy360 sign-in whose email belongs to an unlinked account, until an operator links them", async () => {
    const local = await signUpWithOrg("w360-exists");
    createdUsers.add(local.userId);
    createdOrgs.add(local.orgId);
    const person = newPerson({ email: local.email });
    const refused = await signIn(person);
    expect(refused.ssoError).toBe("account_exists");
    expect(await liveSessionsOf(person)).toBe(0);
    const sameEmail = await adminDb().select({ id: user.id }).from(user).where(eq(user.email, local.email));
    expect(sameEmail).toHaveLength(1);

    const linked = await linkUser(adminDb(), local.userId, person.sub, fake.issuer);
    expect(linked.ok).toBe(true);
    const r = await signIn(person);
    expect(r.ssoError).toBeNull();
    const me = await r.agent.get("/api/v1/me");
    expect(me.body.user.id).toBe(local.userId);
    // The session is bound to the WorkEasy360 organization's tenant; the password account's own organization is not reachable with it.
    expect(me.body.organizations.map((o: { id: string }) => o.id)).toEqual([r.tenantId]);
    expect((await r.agent.get("/api/v1/workspaces").set("x-org-id", local.orgId)).status).toBe(404);
    // The password account still signs in with its password (SSO is optional).
    expect((await local.agent.get("/api/v1/me")).status).toBe(200);
    // An identity is never linked twice.
    expect((await linkUser(adminDb(), local.userId, randomUUID(), fake.issuer)).ok).toBe(false);
  });

  it("links an existing Agents organization to a WorkEasy360 organization (operator), never re-pointing it", async () => {
    const local = await signUpWithOrg("w360-linkorg");
    createdUsers.add(local.userId);
    createdOrgs.add(local.orgId);
    const person = newPerson();
    const linked = await linkOrganization(adminDb(), local.orgId, person.organizationId!, { replaceEmpty: false });
    expect(linked.ok).toBe(true);
    expect((await linkOrganization(adminDb(), local.orgId, randomUUID(), { replaceEmpty: false })).ok).toBe(false);

    const r = await signIn(person);
    expect(r.tenantId).toBe(local.orgId);
    const me = await r.agent.get("/api/v1/me");
    expect(me.body.organizations[0]).toMatchObject({ id: local.orgId, role: "member" });

    // The organization's password members are now subject to its WorkEasy360 entitlement too.
    try {
      fake.entitlement = (org) => (org === person.organizationId ? { status: 200, body: { decision: "deny", reason: "expired", revalidate_after: 900 } } : ALLOW(org));
      clock += 901_000;
      const res = await local.agent.get("/api/v1/workspaces").set("x-org-id", local.orgId);
      expect([res.status, res.body.code]).toEqual([403, "workeasy360_access_ended"]);
    } finally {
      fake.entitlement = ALLOW;
      clock += 901_000;
    }
  });

  it("replaces an empty organization a first sign-in created only with --replace-empty", async () => {
    const person = newPerson();
    const first = await signIn(person);
    const local = await signUpWithOrg("w360-replace");
    createdUsers.add(local.userId);
    createdOrgs.add(local.orgId);
    expect((await linkOrganization(adminDb(), local.orgId, person.organizationId!, { replaceEmpty: false })).ok).toBe(false);
    expect((await linkOrganization(adminDb(), local.orgId, person.organizationId!, { replaceEmpty: true })).ok).toBe(true);
    // The replaced organization is suspended and its WorkEasy360 sessions ended.
    const [old] = await adminDb().select({ status: organization.status }).from(organization).where(eq(organization.id, first.tenantId!));
    expect(old?.status).toBe("suspended");
    expect((await first.agent.get("/api/v1/me")).status).toBe(401);
    const again = await signIn(person);
    expect(again.tenantId).toBe(local.orgId);
  });

  it("refuses a subject linked under a previous issuer name until move-issuer runs", async () => {
    const person = newPerson();
    const first = await signIn(person);
    const oldIssuer = "https://app.workeasy360.example";
    // As if this person had first signed in when the provider had its previous name.
    await adminDb().update(workeasy360Identities).set({ issuer: oldIssuer }).where(eq(workeasy360Identities.subject, person.sub));
    await adminDb().update(session).set({ workeasy360Issuer: oldIssuer }).where(eq(session.workeasy360Subject, person.sub));
    // A session under the old name is refused by the per-request check.
    expect((await first.agent.get("/api/v1/me")).status).toBe(401);
    const refused = await signIn(person);
    expect(refused.ssoError).toBe("identity_conflict");

    const dryRun = await moveIssuer(adminDb(), oldIssuer, fake.issuer, false);
    expect(dryRun).toMatchObject({ ok: true });
    expect(dryRun.message).toMatch(/Would move/);
    const applied = await moveIssuer(adminDb(), oldIssuer, fake.issuer, true);
    expect(applied.ok).toBe(true);
    expect((await first.agent.get("/api/v1/me")).status).toBe(200);
    const again = await signIn(person);
    expect(again.ssoError).toBeNull();
  });
});

describe("WORKEASY360_SSO_ONLY", () => {
  it("refuses password and Google sign-in and password sessions, and keeps WorkEasy360 sign-in working", async () => {
    const local = await signUpWithOrg("w360-ssoonly");
    createdUsers.add(local.userId);
    createdOrgs.add(local.orgId);
    expect((await local.agent.get("/api/v1/me")).status).toBe(200);
    useRuntime({ ssoOnly: true });
    try {
      const config = await request(app).get("/api/public/v1/platform");
      expect(config.body).toMatchObject({ workeasy360: true, ssoOnly: true, signupOpen: false });

      const signInEmail = await request(app).post("/api/auth/sign-in/email").set("Origin", ORIGIN).send({ email: local.email, password: "correct-horse-battery" });
      expect([signInEmail.status, signInEmail.body.code]).toEqual([403, "workeasy360_sso_only"]);
      const signUp = await request(app).post("/api/auth/sign-up/email").set("Origin", ORIGIN).send({ email: `x-${randomUUID()}@test.local`, password: "correct-horse-battery", name: "x" });
      expect(signUp.status).toBe(403);
      const google = await request(app).post("/api/auth/sign-in/social").set("Origin", ORIGIN).send({ provider: "google", callbackURL: "/" });
      expect(google.status).toBe(403);
      const reset = await request(app).post("/api/auth/request-password-reset").set("Origin", ORIGIN).send({ email: local.email });
      expect(reset.status).toBe(403);

      // The existing password session is refused at once, everywhere but sign-out.
      const me = await local.agent.get("/api/v1/me");
      expect([me.status, me.body.code]).toEqual([401, "workeasy360_sign_in_required"]);
      expect((await local.agent.get("/api/v1/workspaces").set("x-org-id", local.orgId)).status).toBe(401);
      expect((await local.agent.get(`/api/auth/organization/get-full-organization?organizationId=${local.orgId}`)).status).toBe(401);

      const r = await signIn(newPerson());
      expect(r.ssoError).toBeNull();
      expect((await r.agent.get("/api/v1/me")).status).toBe(200);
    } finally {
      useRuntime();
    }
    // Off again: the password session works as before.
    expect((await local.agent.get("/api/v1/me")).status).toBe(200);
  });

  it("refuses WorkEasy360 sessions when WorkEasy360 sign-in is switched off", async () => {
    const r = await signIn(newPerson());
    setWorkeasy360Runtime(undefined);
    try {
      expect((await r.agent.get("/api/v1/me")).status).toBe(401);
      expect((await request(app).get("/api/public/v1/platform")).body).toMatchObject({ workeasy360: false, ssoOnly: false });
      const start = await request(app).get("/api/auth/workeasy360/start");
      expect(new URL(start.headers.location as string, ORIGIN).searchParams.get("sso_error")).toBe("not_configured");
    } finally {
      useRuntime();
    }
    expect((await r.agent.get("/api/v1/me")).status).toBe(200);
  });
});

describe("membership", () => {
  it("keeps an existing member's role on the next sign-in", async () => {
    const owner = newPerson();
    const first = await signIn(owner);
    const colleague = newPerson({ organizationId: owner.organizationId });
    await signIn(colleague);
    const [identity] = await adminDb().select().from(workeasy360Identities).where(eq(workeasy360Identities.subject, colleague.sub));
    await adminDb().update(member).set({ role: "admin" }).where(and(eq(member.organizationId, first.tenantId!), eq(member.userId, identity!.userId)));
    const again = await signIn(colleague);
    expect((await again.agent.get("/api/v1/me")).body.organizations[0].role).toBe("admin");
  });
});

// --- Agents' own second factor for the admin area, and the Better Auth side doors -------------------------------

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s) for the base32 secret of an otpauth:// URI. */
function totp(base32Secret: string, stepOffset = 0): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const c of base32Secret.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(c).toString(2).padStart(5, "0");
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000) + stepOffset));
  const mac = createHmac("sha1", key).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

/** A code that is not valid now (nor in the adjacent windows Better Auth accepts). */
function wrongCode(secret: string): string {
  const valid = new Set([-1, 0, 1].map((o) => totp(secret, o)));
  let code = "000000";
  while (valid.has(code)) code = String(Number(code) + 1).padStart(6, "0");
  return code;
}

/** The per-IP limit on Better Auth's two-factor endpoints (5 a minute, app.ts): reset between steps of a test. */
async function resetTwoFactorRateLimit() {
  const keys = await redis().keys("rl:auth-2fa:*");
  if (keys.length) await redis().del(...keys);
}

const PASSWORD = "correct-horse-battery";

/** A platform admin who turned on Agents' own two-factor authentication (with a password session, as today). */
async function twoFactorAdmin() {
  const local = await signUpWithOrg("w360-admin");
  createdUsers.add(local.userId);
  createdOrgs.add(local.orgId);
  await adminDb().update(user).set({ platformRole: "super_admin" }).where(eq(user.id, local.userId));
  const enable = await local.agent.post("/api/auth/two-factor/enable").set("Origin", ORIGIN).send({ password: PASSWORD });
  expect(enable.status).toBe(200);
  const secret = new URL(enable.body.totpURI as string).searchParams.get("secret")!;
  await resetTwoFactorRateLimit();
  const verified = await local.agent.post("/api/auth/two-factor/verify-totp").set("Origin", ORIGIN).send({ code: totp(secret) });
  expect(verified.status).toBe(200);
  return { ...local, secret, backupCodes: enable.body.backupCodes as string[] };
}

/** That admin, linked by the operator to a WorkEasy360 person. */
async function linkedTwoFactorAdmin() {
  const admin = await twoFactorAdmin();
  const person = newPerson({ email: admin.email });
  expect((await linkUser(adminDb(), admin.userId, person.sub, fake.issuer)).ok).toBe(true);
  return { admin, person };
}

const overview = (agent: Agent) => agent.get("/api/admin/v1/overview");
const stepUp = (agent: Agent, code: string, kind: "totp" | "backup-code" = "totp") =>
  agent.post(`/api/auth/two-factor/verify-${kind}`).set("Origin", ORIGIN).send({ code });

describe("admin dashboard: a WorkEasy360 session presents Agents' own second factor", () => {
  it("refuses a WorkEasy360 session of a two-factor admin until that session presents a code, and only that session", async () => {
    const { admin, person } = await linkedTwoFactorAdmin();
    const first = await signIn(person);
    expect(first.ssoError).toBeNull();
    // WorkEasy360 has no MFA and its ID token no amr: the session starts without Agents' second factor.
    const refused = await overview(first.agent);
    expect([refused.status, refused.body.code]).toEqual([403, "two_factor_step_up_required"]);
    expect((await first.agent.get("/api/v1/me")).status).toBe(200);

    await resetTwoFactorRateLimit();
    const wrong = await stepUp(first.agent, wrongCode(admin.secret));
    expect(wrong.status).toBe(401);
    expect((await overview(first.agent)).status).toBe(403);
    const [counted] = await adminDb().select({ n: twoFactor.failedVerificationCount }).from(twoFactor).where(eq(twoFactor.userId, admin.userId));
    expect(counted?.n).toBe(1);

    const right = await stepUp(first.agent, totp(admin.secret));
    expect(right.status).toBe(200);
    expect((await overview(first.agent)).status).toBe(200);
    // Still the same WorkEasy360 session (no new session, no password session), and the failure count restarts.
    const rows = await adminDb()
      .select({ verifiedAt: session.twoFactorVerifiedAt, subject: session.workeasy360Subject })
      .from(session)
      .where(eq(session.userId, admin.userId));
    expect(rows.filter((r) => r.subject === person.sub)).toHaveLength(1);
    expect(rows.find((r) => r.subject === person.sub)?.verifiedAt).toBeInstanceOf(Date);
    const [reset] = await adminDb().select({ n: twoFactor.failedVerificationCount }).from(twoFactor).where(eq(twoFactor.userId, admin.userId));
    expect(reset?.n).toBe(0);

    // A second WorkEasy360 sign-in (another browser) starts without it; a backup code works, once.
    const second = await signIn(person);
    expect((await overview(second.agent)).body.code).toBe("two_factor_step_up_required");
    expect((await overview(first.agent)).status).toBe(200);
    await resetTwoFactorRateLimit();
    expect((await stepUp(second.agent, admin.backupCodes[0]!, "backup-code")).status).toBe(200);
    expect((await overview(second.agent)).status).toBe(200);
    const third = await signIn(person);
    expect((await stepUp(third.agent, admin.backupCodes[0]!, "backup-code")).status).toBe(401);
    expect((await overview(third.agent)).status).toBe(403);
  });

  it("leaves password sessions as they were: the code at sign-in is the second factor", async () => {
    const admin = await twoFactorAdmin();
    // The session that switched two-factor on, and a new password sign-in through Better Auth's challenge.
    expect((await overview(admin.agent)).status).toBe(200);
    const browser = request.agent(app);
    const signInEmail = await browser.post("/api/auth/sign-in/email").set("Origin", ORIGIN).send({ email: admin.email, password: PASSWORD });
    expect(signInEmail.body.twoFactorRedirect).toBe(true);
    expect((await overview(browser)).status).toBe(401);
    await resetTwoFactorRateLimit();
    expect((await browser.post("/api/auth/two-factor/verify-totp").set("Origin", ORIGIN).send({ code: totp(admin.secret) })).status).toBe(200);
    expect((await overview(browser)).status).toBe(200);
  });

  it("locks the step-up on the account's budget of wrong codes, like Better Auth's sign-in challenge", async () => {
    const { admin, person } = await linkedTwoFactorAdmin();
    const r = await signIn(person);
    await adminDb().update(twoFactor).set({ failedVerificationCount: 9 }).where(eq(twoFactor.userId, admin.userId));
    await resetTwoFactorRateLimit();
    expect((await stepUp(r.agent, wrongCode(admin.secret))).status).toBe(401);
    const locked = await stepUp(r.agent, totp(admin.secret));
    expect([locked.status, locked.body.code]).toEqual([429, "ACCOUNT_TEMPORARILY_LOCKED"]);
    expect((await overview(r.agent)).status).toBe(403);
    // Once the lock has passed, a right code works again.
    await adminDb().update(twoFactor).set({ lockedUntil: new Date(Date.now() - 1000) }).where(eq(twoFactor.userId, admin.userId));
    expect((await stepUp(r.agent, totp(admin.secret))).status).toBe(200);
    expect((await overview(r.agent)).status).toBe(200);
  });

  it("keeps the step-up open under WORKEASY360_SSO_ONLY for WorkEasy360 sessions only", async () => {
    const { admin, person } = await linkedTwoFactorAdmin();
    useRuntime({ ssoOnly: true });
    try {
      const r = await signIn(person);
      await resetTwoFactorRateLimit();
      expect((await stepUp(r.agent, totp(admin.secret))).status).toBe(200);
      expect((await overview(r.agent)).status).toBe(200);
      // Without a WorkEasy360 session it is still a local sign-in step, and refused.
      const local = await request(app).post("/api/auth/two-factor/verify-totp").set("Origin", ORIGIN).send({ code: totp(admin.secret) });
      expect([local.status, local.body.code]).toEqual([403, "workeasy360_sso_only"]);
    } finally {
      useRuntime();
    }
  });

  it("refuses a WorkEasy360 session of an admin without two-factor authentication when it is required, as before", async () => {
    const local = await signUpWithOrg("w360-admin-no2fa");
    createdUsers.add(local.userId);
    createdOrgs.add(local.orgId);
    await adminDb().update(user).set({ platformRole: "support" }).where(eq(user.id, local.userId));
    const person = newPerson({ email: local.email });
    expect((await linkUser(adminDb(), local.userId, person.sub, fake.issuer)).ok).toBe(true);
    const r = await signIn(person);
    const mutableEnv = env as { adminRequire2fa: boolean };
    const before = mutableEnv.adminRequire2fa;
    mutableEnv.adminRequire2fa = true;
    try {
      const refused = await overview(r.agent);
      expect([refused.status, refused.body.code]).toEqual([403, "two_factor_required"]);
      expect((await overview(local.agent)).body.code).toBe("two_factor_required");
    } finally {
      mutableEnv.adminRequire2fa = before;
    }
    // Not required (this test environment): the same as a password session of that admin.
    expect((await overview(r.agent)).status).toBe(200);
    expect((await overview(local.agent)).status).toBe(200);
  });
});

/** Queued (not yet delivered) emails of one kind to one address. No worker runs in tests, so they stay queued. */
async function mailTo(to: string, kind: string) {
  const jobs = await getEmailQueue().getJobs(["waiting", "delayed", "prioritized"]);
  return jobs.filter((j) => j.data.to === to && j.name === kind).map((j) => j.data as { text: string });
}

const accountsOf = (userId: string) => adminDb().select({ providerId: account.providerId }).from(account).where(eq(account.userId, userId));

describe("side doors: a WorkEasy360 user gets no password and no Google account while WorkEasy360 sign-in is on", () => {
  it("refuses a Google link and a password by reset, and keeps an operator-linked account's own password", async () => {
    const person = newPerson();
    const r = await signIn(person);
    const userId = (await r.agent.get("/api/v1/me")).body.user.id as string;
    const ctx = await auth.$context;

    // Implicit (or explicit) Google linking creates an account row: refused.
    expect(await ctx.internalAdapter.linkAccount({ providerId: "google", accountId: `g-${randomUUID()}`, userId })).toBeNull();
    // Password reset: no link is sent, and the reset itself could never add a password.
    const ask = () => request(app).post("/api/auth/request-password-reset").set("Origin", ORIGIN).send({ email: person.email, redirectTo: `${ORIGIN}/reset-password` });
    expect((await ask()).status).toBe(200);
    expect(await mailTo(person.email, "reset-password")).toHaveLength(0);
    // A link sent while WorkEasy360 sign-in was off is refused once it is on again.
    setWorkeasy360Runtime(undefined);
    try {
      expect((await ask()).status).toBe(200);
    } finally {
      useRuntime();
    }
    const [mail] = await mailTo(person.email, "reset-password");
    const token = /reset-password\/([A-Za-z0-9_-]+)/.exec(mail!.text)?.[1];
    const reset = await request(app).post("/api/auth/reset-password").set("Origin", ORIGIN).send({ token, newPassword: "a-brand-new-password-1" });
    expect([reset.status, reset.body.code]).toEqual([403, "workeasy360_account"]);
    expect(await accountsOf(userId)).toHaveLength(0);
    // The WorkEasy360 session was not touched.
    expect((await r.agent.get("/api/v1/me")).status).toBe(200);

    // An account linked by the operator keeps the password it had: its reset still works (owner's rule).
    const local = await signUpWithOrg("w360-sidedoor");
    createdUsers.add(local.userId);
    createdOrgs.add(local.orgId);
    expect((await linkUser(adminDb(), local.userId, randomUUID(), fake.issuer)).ok).toBe(true);
    const askLocal = await request(app).post("/api/auth/request-password-reset").set("Origin", ORIGIN).send({ email: local.email, redirectTo: `${ORIGIN}/reset-password` });
    expect(askLocal.status).toBe(200);
    expect(await mailTo(local.email, "reset-password")).toHaveLength(1);
    const [localMail] = await mailTo(local.email, "reset-password");
    const localToken = /reset-password\/([A-Za-z0-9_-]+)/.exec(localMail!.text)?.[1];
    const localReset = await request(app).post("/api/auth/reset-password").set("Origin", ORIGIN).send({ token: localToken, newPassword: "a-brand-new-password-2" });
    expect(localReset.status).toBe(200);
    expect((await accountsOf(local.userId)).map((a) => a.providerId)).toEqual(["credential"]);
    expect(await ctx.internalAdapter.linkAccount({ providerId: "google", accountId: `g-${randomUUID()}`, userId: local.userId })).toBeNull();
  });

  it("leaves accounts without a WorkEasy360 identity, and WorkEasy360 sign-in switched off, as they were", async () => {
    const ctx = await auth.$context;
    const local = await signUpWithOrg("w360-sidedoor-plain");
    createdUsers.add(local.userId);
    createdOrgs.add(local.orgId);
    expect(await ctx.internalAdapter.linkAccount({ providerId: "google", accountId: `g-${randomUUID()}`, userId: local.userId })).not.toBeNull();

    const person = newPerson();
    const r = await signIn(person);
    const userId = (await r.agent.get("/api/v1/me")).body.user.id as string;
    setWorkeasy360Runtime(undefined);
    try {
      expect(await ctx.internalAdapter.linkAccount({ providerId: "google", accountId: `g-${randomUUID()}`, userId })).not.toBeNull();
    } finally {
      useRuntime();
    }
    expect((await accountsOf(userId)).map((a) => a.providerId)).toEqual(["google"]);
  });
});
