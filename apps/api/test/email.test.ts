import { afterAll, describe, expect, it } from "vitest";
import request from "supertest";
import { inArray, sql } from "drizzle-orm";
import { adminDb, closeDb } from "@we360/db";
import { organization, user } from "@we360/db/schema";
import { env } from "../src/config/env";
import { closeQueues, getEmailQueue } from "../src/lib/queue";
import { ORIGIN, app, signUpWithOrg } from "./helpers";

const cleanup: Array<{ orgId: string; userId: string }> = [];
afterAll(async () => {
  await adminDb().delete(organization).where(inArray(organization.id, cleanup.map((c) => c.orgId)));
  await adminDb().delete(user).where(inArray(user.id, cleanup.map((c) => c.userId)));
  await closeQueues();
  await closeDb();
});

/** Queued (not yet delivered) emails to one address. No worker runs in tests, so they stay queued. */
async function mailTo(to: string) {
  const jobs = await getEmailQueue().getJobs(["waiting", "delayed", "prioritized"]);
  return jobs.filter((j) => j.data.to === to).map((j) => ({ kind: j.name, ...j.data }));
}

describe("health", () => {
  it("checks the database and Redis", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok", database: "ok", redis: "ok" });
  });
});

describe("password reset", () => {
  it("queues the email, stores only a hash of the token, and the link works once", async () => {
    const who = await signUpWithOrg("mail-reset");
    cleanup.push(who);
    const res = await request(app).post("/api/auth/request-password-reset").set("Origin", ORIGIN).send({ email: who.email, redirectTo: `${ORIGIN}/reset-password` });
    expect(res.status).toBe(200);

    const [mail] = (await mailTo(who.email)).filter((m) => m.kind === "reset-password");
    expect(mail?.subject).toBe("Reset your password");
    const token = /reset-password\/([A-Za-z0-9_-]+)/.exec(mail!.text)?.[1];
    expect(token).toBeDefined();

    // The database holds only a hash: the plain token appears nowhere.
    const stored = await adminDb().execute<{ n: number }>(sql`select count(*)::int as n from verification where identifier like ${`%${token}%`}`);
    expect(stored.rows[0]?.n).toBe(0);

    const reset = () => request(app).post("/api/auth/reset-password").set("Origin", ORIGIN).send({ token, newPassword: "a-brand-new-password-1" });
    expect((await reset()).status).toBe(200);
    expect((await reset()).status).toBe(400); // single use
    const signIn = await request(app).post("/api/auth/sign-in/email").set("Origin", ORIGIN).send({ email: who.email, password: "a-brand-new-password-1" });
    expect(signIn.status).toBe(200);
    expect((await mailTo(who.email)).some((m) => m.kind === "password-changed")).toBe(true);
  });

  it("gives the same answer for unknown emails", async () => {
    const res = await request(app).post("/api/auth/request-password-reset").set("Origin", ORIGIN).send({ email: "nobody-here@test.local", redirectTo: `${ORIGIN}/reset-password` });
    expect(res.status).toBe(200);
    expect(await mailTo("nobody-here@test.local")).toHaveLength(0);
  });
});

describe("invitations and closed sign-up", () => {
  it("emails the invitation, and only invited addresses can sign up while sign-up is closed", async () => {
    const owner = await signUpWithOrg("mail-inv");
    cleanup.push(owner);
    await adminDb().update(organization).set({ planKey: "business" }).where(inArray(organization.id, [owner.orgId]));
    const invited = `invited-${Date.now()}@test.local`;
    const inv = await owner.agent.post("/api/auth/organization/invite-member").set("Origin", ORIGIN).send({ email: invited, role: "member", organizationId: owner.orgId });
    expect(inv.status).toBe(200);
    const [mail] = await mailTo(invited);
    expect(mail?.kind).toBe("invitation");
    expect(mail?.text).toContain(`/accept-invitation/${inv.body.id}`);

    env.allowPublicSignup = false;
    try {
      const stranger = await request(app).post("/api/auth/sign-up/email").set("Origin", ORIGIN).send({ email: `stranger-${Date.now()}@test.local`, password: "correct-horse-battery", name: "x" });
      expect(stranger.status).toBe(403);
      expect(stranger.body.code).toBe("signup_closed");
      const ok = await request(app).post("/api/auth/sign-up/email").set("Origin", ORIGIN).send({ email: invited, password: "correct-horse-battery", name: "Invited" });
      expect(ok.status).toBe(200);
      cleanup.push({ orgId: owner.orgId, userId: ok.body.user.id });
    } finally {
      env.allowPublicSignup = true;
    }
  });
});

describe("password reset link from a platform admin", () => {
  it("is super-admin only, audited, and works once", async () => {
    const admin = await signUpWithOrg("mail-admin");
    const target = await signUpWithOrg("mail-target");
    cleanup.push(admin, target);
    const path = `/api/admin/v1/users/${target.userId}/password-reset-link`;
    expect((await target.agent.post(path).set("Origin", ORIGIN)).status).toBe(404); // customers can't see the admin API

    await adminDb().update(user).set({ platformRole: "super_admin" }).where(inArray(user.id, [admin.userId]));
    const res = await admin.agent.post(path).set("Origin", ORIGIN);
    expect(res.status).toBe(200);
    const token = new URL(res.body.url).searchParams.get("token");
    const reset = () => request(app).post("/api/auth/reset-password").set("Origin", ORIGIN).send({ token, newPassword: "set-by-reset-link-1" });
    expect((await reset()).status).toBe(200);
    expect((await reset()).status).toBe(400);
    const audit = await adminDb().execute<{ n: number }>(
      sql`select count(*)::int as n from audit_logs where action = 'admin.user.password_reset_link_created' and target_id = ${target.userId}`,
    );
    expect(audit.rows[0]?.n).toBe(1);
  });
});
