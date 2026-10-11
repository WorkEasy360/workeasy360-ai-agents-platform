import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { adminDb, closeDb } from "@we360/db";
import { documents, organization, user } from "@we360/db/schema";
import { ingestDocument } from "../src/modules/knowledge/ingestion";
import { closeQueues } from "../src/lib/queue";
import { ORIGIN, app, signUpWithOrg } from "./helpers";

/** Parses an SSE response body into events. */
function sseEvents(text: string): Array<{ type: string } & Record<string, unknown>> {
  return text
    .split("\n\n")
    .map((block) => block.split("\n").find((l) => l.startsWith("data: ")))
    .filter(Boolean)
    .map((l) => JSON.parse(l!.slice(6)));
}

let owner: Awaited<ReturnType<typeof signUpWithOrg>>;
let agentId: string;

beforeAll(async () => {
  owner = await signUpWithOrg("runner");
  const res = await owner.agent.post("/api/v1/agents").set("Origin", ORIGIN).send({ name: "Helper", templateKey: "customer_support" });
  expect(res.status).toBe(201);
  agentId = res.body.id;
});

afterAll(async () => {
  await adminDb().delete(organization).where(eq(organization.id, owner.orgId));
  await adminDb().delete(user).where(inArray(user.id, [owner.userId]));
  await closeQueues();
  await closeDb();
});

describe("plan limits", () => {
  it("allows one agent on Free and blocks the second", async () => {
    const res = await owner.agent.post("/api/v1/agents").set("Origin", ORIGIN).send({ name: "Second" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("plan_limit_reached");
  });

  it("picks a model the plan allows", async () => {
    const agent = await owner.agent.get(`/api/v1/agents/${agentId}`);
    const models = await owner.agent.get("/api/v1/models");
    const chosen = models.body.data.find((m: { id: string }) => m.id === agent.body.draftConfig.model.modelId);
    expect(chosen?.allowedOnPlan).toBe(true);
  });

  it("blocks API deployments on Free", async () => {
    const res = await owner.agent.post(`/api/v1/agents/${agentId}/deployments`).set("Origin", ORIGIN).send({ channel: "api" });
    expect(res.status).toBe(403);
  });
});

describe("playground and publishing", () => {
  it("streams a test run with trace events and records cost", async () => {
    const res = await owner.agent.post(`/api/v1/agents/${agentId}/test`).set("Origin", ORIGIN).send({ message: "Hello there" });
    expect(res.status).toBe(200);
    const events = sseEvents(res.text);
    expect(events[0]?.type).toBe("run.started");
    expect(events.some((e) => e.type === "text.delta")).toBe(true);
    expect(events.some((e) => e.type === "llm.step")).toBe(true);
    const done = events.find((e) => e.type === "run.completed") as { usage: { costUsd: number } } | undefined;
    expect(done?.usage.costUsd).toBeGreaterThan(0);
  });

  it("rejects a stale autosave", async () => {
    const agent = (await owner.agent.get(`/api/v1/agents/${agentId}`)).body;
    const ok = await owner.agent.patch(`/api/v1/agents/${agentId}`).set("Origin", ORIGIN).send({ draftRevision: agent.draftRevision, name: "Helper v2" });
    expect(ok.status).toBe(200);
    const stale = await owner.agent.patch(`/api/v1/agents/${agentId}`).set("Origin", ORIGIN).send({ draftRevision: agent.draftRevision, name: "Lost" });
    expect(stale.status).toBe(409);
  });

  it("publishes immutable versions and clears the unpublished flag", async () => {
    const v1 = await owner.agent.post(`/api/v1/agents/${agentId}/publish`).set("Origin", ORIGIN).send({ changeNote: "first" });
    expect(v1.status).toBe(201);
    expect(v1.body.versionNo).toBe(1);
    const agent = await owner.agent.get(`/api/v1/agents/${agentId}`);
    expect(agent.body.hasUnpublishedChanges).toBe(false);
    expect(agent.body.publishedVersion.versionNo).toBe(1);
  });
});

describe("public chat page", () => {
  let publicKey: string;

  beforeAll(async () => {
    const res = await owner.agent.post(`/api/v1/agents/${agentId}/deployments`).set("Origin", ORIGIN).send({ channel: "hosted_page" });
    expect(res.status).toBe(201);
    publicKey = res.body.publicKey;
  });

  it("serves config and streams answers without debug events", async () => {
    const cfg = await request(app).get(`/api/public/v1/deployments/${publicKey}`);
    expect(cfg.status).toBe(200);
    expect(cfg.body.showBranding).toBe(true);

    const res = await request(app).post(`/api/public/v1/deployments/${publicKey}/messages`).send({ message: "Hi" });
    const events = sseEvents(res.text);
    expect(events.some((e) => e.type === "run.completed")).toBe(true);
    expect(events.some((e) => e.type === "llm.step" || e.type === "tool.result")).toBe(false);
    const done = events.find((e) => e.type === "run.completed")!;
    expect(done.usage).toBeUndefined();
  });

  it("starts a new conversation instead of continuing a playground conversation", async () => {
    const test = sseEvents((await owner.agent.post(`/api/v1/agents/${agentId}/test`).set("Origin", ORIGIN).send({ message: "secret context" })).text);
    const privateConv = (test[0] as unknown as { conversationId: string }).conversationId;
    const pub = sseEvents((await request(app).post(`/api/public/v1/deployments/${publicKey}/messages`).send({ message: "hi", conversationId: privateConv })).text);
    expect((pub[0] as unknown as { conversationId: string }).conversationId).not.toBe(privateConv);
  });

  it("stops serving when the channel is paused", async () => {
    const list = await owner.agent.get(`/api/v1/agents/${agentId}/deployments`);
    const id = list.body.data.find((d: { channel: string }) => d.channel === "hosted_page").id;
    await owner.agent.patch(`/api/v1/agents/${agentId}/deployments/${id}`).set("Origin", ORIGIN).send({ status: "paused" });
    const res = await request(app).get(`/api/public/v1/deployments/${publicKey}`);
    expect(res.status).toBe(503);
  });

  it("returns 404 for unknown keys", async () => {
    const res = await request(app).get("/api/public/v1/deployments/pk_doesnotexist12345");
    expect(res.status).toBe(404);
  });
});

describe("developer API", () => {
  it("runs an agent with an API key once the plan allows it", async () => {
    await adminDb().update(organization).set({ planKey: "starter" }).where(eq(organization.id, owner.orgId));
    const dep = await owner.agent.post(`/api/v1/agents/${agentId}/deployments`).set("Origin", ORIGIN).send({ channel: "api" });
    expect(dep.status).toBe(201);
    const key = await owner.agent.post("/api/v1/api-keys").set("Origin", ORIGIN).send({ name: "ci" });
    expect(key.body.secret).toMatch(/^we360_sk_/);

    const run = await request(app).post(`/api/v1/runs/agents/${agentId}`).set("Authorization", `Bearer ${key.body.secret}`).send({ message: "Ping", userId: "cust-1" });
    expect(run.status).toBe(200);
    expect(run.body.status).toBe("succeeded");
    expect(run.body.conversationId).toBeTruthy();

    // Revoked keys stop working immediately.
    await owner.agent.delete(`/api/v1/api-keys/${key.body.id}`).set("Origin", ORIGIN);
    const after = await request(app).post(`/api/v1/runs/agents/${agentId}`).set("Authorization", `Bearer ${key.body.secret}`).send({ message: "Ping" });
    expect(after.status).toBe(401);
  });

  it("never returns a stored credential secret", async () => {
    const created = await owner.agent
      .post("/api/v1/credentials")
      .set("Origin", ORIGIN)
      .send({ name: "CRM", authType: "bearer", secret: "super-secret-token-9876" });
    expect(created.status).toBe(201);
    expect(JSON.stringify(created.body)).not.toContain("super-secret");
    expect(created.body.last4).toBe("9876");
    const list = await owner.agent.get("/api/v1/credentials");
    expect(JSON.stringify(list.body)).not.toContain("super-secret");
  });
});

describe("knowledge", () => {
  it("ingests a text document and finds it with hybrid search", async () => {
    const kb = await owner.agent.post("/api/v1/knowledge-bases").set("Origin", ORIGIN).send({ name: "Docs" });
    const doc = await owner.agent
      .post(`/api/v1/knowledge-bases/${kb.body.id}/documents/text`)
      .set("Origin", ORIGIN)
      .send({ title: "Warranty", text: "# Warranty\n\nAll appliances carry a two year warranty covering manufacturing defects." });
    expect(doc.status).toBe(201);

    // Run the worker step inline.
    await ingestDocument(owner.orgId, doc.body.id);
    const [row] = await adminDb().select().from(documents).where(eq(documents.id, doc.body.id));
    expect(row?.status).toBe("ready");

    const search = await owner.agent.post(`/api/v1/knowledge-bases/${kb.body.id}/search`).set("Origin", ORIGIN).send({ query: "warranty defects" });
    expect(search.body.data[0]?.documentTitle).toBe("Warranty");
  });
});
