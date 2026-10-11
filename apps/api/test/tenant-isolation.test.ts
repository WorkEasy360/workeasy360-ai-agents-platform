import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { adminDb, appDb, closeDb, withTenant } from "@we360/db";
import { organization, user, workspaces } from "@we360/db/schema";
import request from "supertest";
import { ORIGIN, app, signUpWithOrg } from "./helpers";

let a: Awaited<ReturnType<typeof signUpWithOrg>>;
let b: Awaited<ReturnType<typeof signUpWithOrg>>;

beforeAll(async () => {
  a = await signUpWithOrg("alpha");
  b = await signUpWithOrg("bravo");
});

afterAll(async () => {
  await adminDb().delete(organization).where(eq(organization.id, a.orgId));
  await adminDb().delete(organization).where(eq(organization.id, b.orgId));
  await adminDb().delete(user).where(inArray(user.id, [a.userId, b.userId]));
  await closeDb();
});

describe("row-level security", () => {
  it("returns no tenant rows when no org is set", async () => {
    const rows = await appDb().select().from(workspaces);
    expect(rows).toHaveLength(0);
  });

  it("only returns the current org's rows", async () => {
    const rows = await withTenant(a.orgId, (tx) => tx.select({ orgId: workspaces.orgId }).from(workspaces));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.orgId === a.orgId)).toBe(true);
  });

  it("can't read another org's rows even when filtering for them explicitly", async () => {
    const rows = await withTenant(a.orgId, (tx) => tx.select().from(workspaces).where(eq(workspaces.orgId, b.orgId)));
    expect(rows).toHaveLength(0);
  });

  it("rejects writes into another org", async () => {
    const err = await withTenant(a.orgId, (tx) =>
      tx.insert(workspaces).values({ orgId: b.orgId, name: "intrusion", slug: "intrusion" }),
    ).then(
      () => undefined,
      (e: unknown) => e as Error & { cause?: Error },
    );
    // Drizzle wraps the driver error; the Postgres message is on `cause`.
    expect(err?.cause?.message).toMatch(/row-level security/);
  });

  it("can't update another org's rows", async () => {
    const updated = await withTenant(a.orgId, (tx) =>
      tx.update(workspaces).set({ name: "hijacked" }).where(eq(workspaces.orgId, b.orgId)).returning(),
    );
    expect(updated).toHaveLength(0);
  });

  it("does not leak app.org_id to the next transaction on the same pool", async () => {
    await withTenant(a.orgId, async () => undefined);
    const [row] = (await appDb().execute<{ org: string | null }>(sql`select current_setting('app.org_id', true) as org`))
      .rows;
    expect(row?.org ?? "").toBe("");
  });
});

describe("API tenant resolution", () => {
  it("lets a member read their own org", async () => {
    const res = await a.agent.get("/api/v1/workspaces").set("X-Org-Id", a.orgId);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it("returns 404 when a user targets an org they don't belong to", async () => {
    const res = await a.agent.get("/api/v1/workspaces").set("X-Org-Id", b.orgId);
    expect(res.status).toBe(404);
    expect(res.body.code).toBe("not_found");
  });

  it("returns 401 without a session", async () => {
    const res = await request(app).get("/api/v1/workspaces");
    expect(res.status).toBe(401);
  });

  it("ignores client attempts to set the plan on org creation", async () => {
    const res = await a.agent
      .post("/api/auth/organization/create")
      .set("Origin", ORIGIN)
      .send({ name: "sneaky", slug: `sneaky-${Date.now()}`, planKey: "enterprise" });
    // Better Auth rejects or strips non-input fields; either way the plan must not be enterprise.
    if (res.status === 200) {
      expect(res.body.planKey).toBe("free");
      await adminDb().delete(organization).where(eq(organization.id, res.body.id));
    } else {
      // 400: field rejected; 403: refused earlier by the one-free-organization-per-user limit.
      expect([400, 403]).toContain(res.status);
    }
  });

  it("blocks invitations beyond the plan's member limit (Free = 1 member)", async () => {
    const res = await a.agent
      .post("/api/auth/organization/invite-member")
      .set("Origin", ORIGIN)
      .send({ email: "teammate@test.local", role: "member", organizationId: a.orgId });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("plan_limit_reached");
  });

  it("hides the admin API from non-staff", async () => {
    const res = await a.agent.get("/api/admin/v1/overview");
    expect(res.status).toBe(404);
  });
});
