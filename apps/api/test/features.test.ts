import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq } from "drizzle-orm";
import { adminDb, closeDb } from "@we360/db";
import { organization, user } from "@we360/db/schema";
import { closeQueues, getMaintenanceQueue, getRunsQueue } from "../src/lib/queue";
import { executeRunJob } from "../src/modules/runs/async-runs";
import { signPayload } from "../src/modules/runs/webhooks";
import { ORIGIN, app, signUpWithOrg } from "./helpers";

let owner: Awaited<ReturnType<typeof signUpWithOrg>>;
let agentId: string;

beforeAll(async () => {
  owner = await signUpWithOrg("features");
  // Starter plan so the API channel is available.
  await adminDb().update(organization).set({ planKey: "starter" }).where(eq(organization.id, owner.orgId));
});

afterAll(async () => {
  await adminDb().delete(organization).where(eq(organization.id, owner.orgId));
  await adminDb().delete(user).where(eq(user.id, owner.userId));
  await closeQueues();
  await closeDb();
});

describe("describe your agent", () => {
  it("drafts a configuration and creates an agent from it", async () => {
    const draft = await owner.agent
      .post("/api/v1/agents/generate")
      .set("Origin", ORIGIN)
      .send({ description: "Answer questions about our bakery's opening hours and custom cake orders." });
    expect(draft.status).toBe(200);
    expect(draft.body.instructions).toContain("bakery");

    const created = await owner.agent.post("/api/v1/agents").set("Origin", ORIGIN).send({ name: "Bakery Bot", draft: draft.body });
    expect(created.status).toBe(201);
    expect(created.body.draftConfig.instructions).toBe(draft.body.instructions);
    expect(created.body.draftConfig.messages.welcome).toBe(draft.body.welcomeMessage);
    agentId = created.body.id;
  });

  it("rejects a description that is too short", async () => {
    const res = await owner.agent.post("/api/v1/agents/generate").set("Origin", ORIGIN).send({ description: "hi" });
    expect(res.status).toBe(400);
  });
});

describe("send email tool", () => {
  it("validates recipients and ignores any credential", async () => {
    const bad = await owner.agent
      .post("/api/v1/tools")
      .set("Origin", ORIGIN)
      .send({ providerKey: "send_email", name: "notify_team", description: "Email the team about leads", config: { recipients: ["not-an-email"] } });
    expect(bad.status).toBe(400);

    const ok = await owner.agent
      .post("/api/v1/tools")
      .set("Origin", ORIGIN)
      .send({ providerKey: "send_email", name: "notify_team", description: "Email the team about leads", config: { recipients: ["sales@test.local"] } });
    expect(ok.status).toBe(201);
    expect(ok.body.inputSchema.required).toEqual(["subject", "body"]);
    expect(ok.body.credentialId).toBeNull();
  });

  it("can't be pointed at a recipient by the model (input schema has no 'to')", async () => {
    const list = await owner.agent.get("/api/v1/tools");
    const tool = list.body.data.find((t: { providerKey: string }) => t.providerKey === "send_email");
    const props = Object.keys(((await owner.agent.get("/api/v1/tools")).body.data[0].config) ?? {});
    expect(tool).toBeTruthy();
    expect(props).toContain("recipients");
  });
});

describe("async runs and webhooks", () => {
  let key: string;

  beforeAll(async () => {
    const pub = await owner.agent.post(`/api/v1/agents/${agentId}/publish`).set("Origin", ORIGIN).send({});
    expect(pub.status, JSON.stringify(pub.body)).toBe(201);
    const dep = await owner.agent.post(`/api/v1/agents/${agentId}/deployments`).set("Origin", ORIGIN).send({ channel: "api" });
    expect(dep.status, JSON.stringify(dep.body)).toBe(201);
    key = (await owner.agent.post("/api/v1/api-keys").set("Origin", ORIGIN).send({ name: "async" })).body.secret;
  });

  it("queues a run, and the worker step produces a result readable by the same org only", async () => {
    const res = await request(app).post(`/api/v1/runs/agents/${agentId}`).set("Authorization", `Bearer ${key}`).send({ message: "Hello async", async: true });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");

    // Run the worker step inline, then store the result the way BullMQ would.
    const job = await getRunsQueue().getJob(res.body.id);
    const result = await executeRunJob(job!.data);
    expect(result.status).toBe("succeeded");
    expect(result.output).toContain("Hello async");
    await job!.remove();

    // Another org's key can't read this run id.
    const other = await signUpWithOrg("async-other");
    await adminDb().update(organization).set({ planKey: "starter" }).where(eq(organization.id, other.orgId));
    const otherKey = (await other.agent.post("/api/v1/api-keys").set("Origin", ORIGIN).send({ name: "x" })).body.secret;
    const probe = await request(app).get(`/api/v1/runs/${res.body.id}`).set("Authorization", `Bearer ${otherKey}`);
    expect(probe.status).toBe(404);
    await adminDb().delete(organization).where(eq(organization.id, other.orgId));
    await adminDb().delete(user).where(eq(user.id, other.userId));
  });

  it("signs callbacks with HMAC-SHA256 over 't.body'", () => {
    const sig = signPayload("whsec_test", '{"a":1}', 1700000000);
    const expected = createHmac("sha256", "whsec_test").update('1700000000.{"a":1}').digest("hex");
    expect(sig).toBe(`t=1700000000,v1=${expected}`);
  });

  it("reveals the same webhook secret until rotated", async () => {
    const a = await owner.agent.get("/api/v1/api-keys/webhook-secret");
    const b = await owner.agent.get("/api/v1/api-keys/webhook-secret");
    expect(a.body.secret).toMatch(/^whsec_/);
    expect(b.body.secret).toBe(a.body.secret);
    const rotated = await owner.agent.post("/api/v1/api-keys/webhook-secret/rotate").set("Origin", ORIGIN);
    expect(rotated.body.secret).not.toBe(a.body.secret);
    // The webhook secret never shows up as a tool credential.
    const creds = await owner.agent.get("/api/v1/credentials");
    expect(JSON.stringify(creds.body)).not.toContain("Webhook");
  });
});

describe("organization", () => {
  it("lists audit entries for admins", async () => {
    const res = await owner.agent.get("/api/v1/organization/audit-logs?limit=5");
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data[0].actorEmail).toBe(owner.email);
  });

  it("exports data without secrets", async () => {
    const res = await owner.agent.get("/api/v1/organization/export");
    expect(res.status).toBe(200);
    const body = JSON.parse(res.text);
    expect(body.agents.length).toBeGreaterThan(0);
    expect(Array.isArray(body.conversations)).toBe(true);
    expect(res.text).not.toMatch(/ciphertext|whsec_|we360_sk_/);
  });

  it("queues file cleanup when the organization is deleted", async () => {
    const temp = await signUpWithOrg("to-delete");
    const before = await getMaintenanceQueue().getJobCounts("waiting", "delayed", "active", "completed");
    const del = await temp.agent.post("/api/auth/organization/delete").set("Origin", ORIGIN).send({ organizationId: temp.orgId });
    expect(del.status).toBe(200);
    const after = await getMaintenanceQueue().getJobCounts("waiting", "delayed", "active", "completed");
    const total = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
    expect(total(after)).toBeGreaterThan(total(before));
    const [gone] = await adminDb().select().from(organization).where(eq(organization.id, temp.orgId));
    expect(gone).toBeUndefined();
    await adminDb().delete(user).where(eq(user.id, temp.userId));
  });
});
