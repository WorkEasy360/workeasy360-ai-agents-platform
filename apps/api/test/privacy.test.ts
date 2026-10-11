import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, type SQL } from "drizzle-orm";
import { adminDb, closeDb, withTenant } from "@we360/db";
import { account, agents, auditLogs, conversations, executions, member, messages, organization, user, workspaces } from "@we360/db/schema";
import { hashPassword as scryptHash } from "better-auth/crypto";
import request from "supertest";
import { closeQueues } from "../src/lib/queue";
import { applyAuditRetention } from "../src/modules/privacy/retention";
import { ORIGIN, app, signUpWithOrg } from "./helpers";

let a: Awaited<ReturnType<typeof signUpWithOrg>>;
let b: Awaited<ReturnType<typeof signUpWithOrg>>;
let agentA: string;
let agentB: string;

/** A conversation with one message and one run log, written directly (no model call). */
async function seedConversation(orgId: string, agentId: string, endUserRef: string, deploymentId?: string) {
  return withTenant(orgId, async (tx) => {
    const [ws] = await tx.select({ id: workspaces.id }).from(workspaces).limit(1);
    const [c] = await tx
      .insert(conversations)
      .values({ orgId, agentId, deploymentId, channel: deploymentId ? "hosted_page" : "api", endUserRef, title: "hi", lastMessageAt: new Date() })
      .returning({ id: conversations.id });
    await tx.insert(messages).values({ orgId, conversationId: c!.id, role: "user", content: { text: "my number is 98xxxxxx" } });
    await tx.insert(executions).values({ orgId, workspaceId: ws!.id, agentId, conversationId: c!.id, source: "api", status: "succeeded", inputPreview: "my number" });
    return c!.id;
  });
}

const count = async (orgId: string, where: SQL) =>
  (await withTenant(orgId, (tx) => tx.select({ id: conversations.id }).from(conversations).where(where))).length;

beforeAll(async () => {
  a = await signUpWithOrg("privacy-a");
  b = await signUpWithOrg("privacy-b");
  const mk = async (who: typeof a) => {
    const res = await who.agent.post("/api/v1/agents").set("Origin", ORIGIN).set("x-org-id", who.orgId).send({ name: "Bot", draft: { instructions: "Be nice." } });
    await who.agent.post(`/api/v1/agents/${res.body.id}/publish`).set("Origin", ORIGIN).set("x-org-id", who.orgId).send({});
    return res.body.id as string;
  };
  agentA = await mk(a);
  agentB = await mk(b);
});

afterAll(async () => {
  await adminDb().delete(organization).where(inArray(organization.id, [a.orgId, b.orgId]));
  await adminDb().delete(user).where(inArray(user.id, [a.userId, b.userId]));
  await closeQueues();
  await closeDb();
});

describe("end-user erasure", () => {
  it("deletes only the requesting org's conversations for that user id, with messages and run logs", async () => {
    const mine = await seedConversation(a.orgId, agentA, "cust-1");
    await seedConversation(b.orgId, agentB, "cust-1"); // same id, other tenant

    const res = await a.agent.post("/api/v1/privacy/end-users/erase").set("Origin", ORIGIN).set("x-org-id", a.orgId).send({ endUserRef: "cust-1" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ conversations: 1, executions: 1 });

    const left = await withTenant(a.orgId, (tx) => tx.select().from(executions).where(eq(executions.conversationId, mine)));
    expect(left).toHaveLength(0);
    expect(await count(a.orgId, eq(conversations.endUserRef, "cust-1"))).toBe(0);
    expect(await count(b.orgId, eq(conversations.endUserRef, "cust-1"))).toBe(1);
  });

  it("audits the request with a fingerprint, not the user id", async () => {
    const [row] = await adminDb()
      .select({ targetId: auditLogs.targetId })
      .from(auditLogs)
      .where(and(eq(auditLogs.orgId, a.orgId), eq(auditLogs.action, "privacy.end_user_erased")));
    expect(row?.targetId).toMatch(/^[0-9a-f]{12}$/);
  });

  it("is limited to admins", async () => {
    await adminDb().insert(member).values({ organizationId: a.orgId, userId: b.userId, role: "member", createdAt: new Date() });
    const res = await b.agent.post("/api/v1/privacy/end-users/erase").set("Origin", ORIGIN).set("x-org-id", a.orgId).send({ endUserRef: "cust-1" });
    expect(res.status).toBe(403);
    await adminDb().delete(member).where(and(eq(member.organizationId, a.orgId), eq(member.userId, b.userId)));
  });

  it("won't delete another org's conversation by id", async () => {
    const theirs = await seedConversation(b.orgId, agentB, "cust-2");
    const res = await a.agent.delete(`/api/v1/conversations/${theirs}`).set("Origin", ORIGIN).set("x-org-id", a.orgId);
    expect(res.status).toBe(404);
    expect(await count(b.orgId, eq(conversations.id, theirs))).toBe(1);
  });
});

describe("visitor deletes their chat", () => {
  it("requires the same visitor id and deployment", async () => {
    const dep = await a.agent
      .post(`/api/v1/agents/${agentA}/deployments`)
      .set("Origin", ORIGIN)
      .set("x-org-id", a.orgId)
      .send({ channel: "hosted_page", config: { privacyPolicyUrl: "https://example.com/privacy" } });
    expect(dep.status).toBe(201);
    const conv = await seedConversation(a.orgId, agentA, "visitor-1", dep.body.id);

    const pub = await a.agent.get(`/api/public/v1/deployments/${dep.body.publicKey}`);
    expect(pub.body.privacyPolicyUrl).toBe("https://example.com/privacy");

    const path = `/api/public/v1/deployments/${dep.body.publicKey}/conversations/${conv}`;
    await a.agent.delete(path).send({ visitorId: "visitor-2" }).expect(200);
    expect(await count(a.orgId, eq(conversations.id, conv))).toBe(1);
    await a.agent.delete(path).send({ visitorId: "visitor-1" }).expect(200);
    expect(await count(a.orgId, eq(conversations.id, conv))).toBe(0);
  });
});

describe("retention setting", () => {
  it("accepts only the offered values, from the owner", async () => {
    const bad = await a.agent.patch("/api/v1/privacy/settings").set("Origin", ORIGIN).set("x-org-id", a.orgId).send({ conversationRetentionDays: 3650 });
    expect(bad.status).toBe(400);
    const ok = await a.agent.patch("/api/v1/privacy/settings").set("Origin", ORIGIN).set("x-org-id", a.orgId).send({ conversationRetentionDays: 90 });
    expect(ok.status).toBe(200);
    const [org] = await adminDb().select({ days: organization.conversationRetentionDays }).from(organization).where(eq(organization.id, a.orgId));
    expect(org?.days).toBe(90);
  });
});

describe("account deletion", () => {
  it("is blocked while the user is the only owner of an org others use", async () => {
    await adminDb().insert(member).values({ organizationId: a.orgId, userId: b.userId, role: "member", createdAt: new Date() });
    const plan = await a.agent.get("/api/v1/me/account-deletion");
    expect(plan.body.blockingOrganizations).toHaveLength(1);
    const res = await a.agent.post("/api/auth/delete-user").set("Origin", ORIGIN).send({ password: "correct-horse-battery" });
    expect(res.status).toBe(400);
    expect((await adminDb().select().from(user).where(eq(user.id, a.userId))).length).toBe(1);
    await adminDb().delete(member).where(and(eq(member.organizationId, a.orgId), eq(member.userId, b.userId)));
  });

  it("deletes the user and their solo organization", async () => {
    const solo = await signUpWithOrg("privacy-solo");
    const res = await solo.agent.post("/api/auth/delete-user").set("Origin", ORIGIN).send({ password: "correct-horse-battery" });
    expect(res.status).toBe(200);
    expect(await adminDb().select().from(user).where(eq(user.id, solo.userId))).toHaveLength(0);
    expect(await adminDb().select().from(organization).where(eq(organization.id, solo.orgId))).toHaveLength(0);
    expect(await adminDb().select().from(agents).where(eq(agents.orgId, solo.orgId))).toHaveLength(0);
  });
});

describe("password hashes", () => {
  it("stores new passwords with Argon2id", async () => {
    const [acc] = await adminDb().select({ password: account.password }).from(account).where(and(eq(account.userId, b.userId), eq(account.providerId, "credential")));
    expect(acc?.password).toMatch(/^\$argon2id\$/);
  });

  it("upgrades an old scrypt hash when the user signs in", async () => {
    await adminDb()
      .update(account)
      .set({ password: await scryptHash("correct-horse-battery") })
      .where(and(eq(account.userId, b.userId), eq(account.providerId, "credential")));
    const res = await request(app).post("/api/auth/sign-in/email").set("Origin", ORIGIN).send({ email: b.email, password: "correct-horse-battery" });
    expect(res.status).toBe(200);
    const [acc] = await adminDb().select({ password: account.password }).from(account).where(and(eq(account.userId, b.userId), eq(account.providerId, "credential")));
    expect(acc?.password).toMatch(/^\$argon2id\$/);
  });
});

describe("audit log retention", () => {
  it("clears IP and browser after 90 days, deletes after a year, and strips entries of deleted organizations", async () => {
    const day = 86_400_000;
    const gone = "00000000-0000-4000-8000-00000000dead"; // an organization that no longer exists
    const rows = await adminDb()
      .insert(auditLogs)
      .values([
        { orgId: b.orgId, actorType: "user", action: "test.recent", ip: "203.0.113.7", userAgent: "UA", createdAt: new Date(Date.now() - 10 * day) },
        { orgId: b.orgId, actorType: "user", action: "test.old", ip: "203.0.113.7", userAgent: "UA", createdAt: new Date(Date.now() - 100 * day) },
        { orgId: b.orgId, actorType: "user", action: "test.ancient", ip: "203.0.113.7", createdAt: new Date(Date.now() - 400 * day) },
        { orgId: gone, actorType: "user", action: "test.orphan", ip: "203.0.113.7", diff: { name: "Asha" }, createdAt: new Date() },
      ])
      .returning({ id: auditLogs.id, action: auditLogs.action });
    await applyAuditRetention();
    const after = await adminDb().select().from(auditLogs).where(inArray(auditLogs.id, rows.map((r) => r.id)));
    const by = (action: string) => after.find((r) => r.action === action);
    expect(by("test.recent")?.ip).toBe("203.0.113.7");
    expect([by("test.old")?.ip, by("test.old")?.userAgent]).toEqual([null, null]);
    expect(by("test.ancient")).toBeUndefined();
    expect([by("test.orphan")?.ip, by("test.orphan")?.diff]).toEqual([null, null]);
    await adminDb().delete(auditLogs).where(inArray(auditLogs.id, rows.map((r) => r.id)));
  });
});
