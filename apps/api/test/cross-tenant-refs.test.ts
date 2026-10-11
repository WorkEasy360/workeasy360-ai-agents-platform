import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { adminDb, closeDb, withTenant } from "@we360/db";
import { agents, conversations, executions, messages, organization, tools, user, workspaces } from "@we360/db/schema";
import { closeQueues } from "../src/lib/queue";
import { ORIGIN, signUpWithOrg } from "./helpers";

/**
 * Org B (an attacker with a normal account) points its own requests and objects at org A's IDs:
 * direct reads/writes, and nested references (templates, knowledge bases, tools, credentials,
 * pinned versions, conversations). Nothing of A's may be returned, used or changed.
 */
type Who = Awaited<ReturnType<typeof signUpWithOrg>>;
let A: Who;
let B: Who;
const ids: Record<string, string> = {};
const as = (who: Who) => ({
  get: (p: string) => who.agent.get(p).set("x-org-id", who.orgId),
  post: (p: string, body: unknown = {}) => who.agent.post(p).set("Origin", ORIGIN).set("x-org-id", who.orgId).send(body as object),
  patch: (p: string, body: unknown) => who.agent.patch(p).set("Origin", ORIGIN).set("x-org-id", who.orgId).send(body as object),
  del: (p: string) => who.agent.delete(p).set("Origin", ORIGIN).set("x-org-id", who.orgId),
});

beforeAll(async () => {
  A = await signUpWithOrg("xref-a");
  B = await signUpWithOrg("xref-b");
  await adminDb().update(organization).set({ planKey: "business" }).where(inArray(organization.id, [A.orgId, B.orgId]));
  const a = as(A);
  ids.cred = (await a.post("/api/v1/credentials", { name: "A key", authType: "bearer", secret: "a-secret-value-123" })).body.id;
  ids.tool = (
    await a.post("/api/v1/tools", {
      name: "a_lookup",
      description: "Looks up an order in A's system",
      config: { method: "GET", url: "https://api.example.com/orders/{id}", params: [{ name: "id", type: "string", required: true }] },
      credentialId: ids.cred,
    })
  ).body.id;
  ids.kb = (await a.post("/api/v1/knowledge-bases", { name: "A secrets" })).body.id;
  ids.doc = (await a.post(`/api/v1/knowledge-bases/${ids.kb}/documents/text`, { title: "A payroll", text: "Salary of the CEO is 123" })).body.id;
  const agent = (await a.post("/api/v1/agents", { name: "A bot", draft: { instructions: "A's private instructions" } })).body;
  ids.agent = agent.id;
  await a.post(`/api/v1/agents/${ids.agent}/publish`);
  ids.version = (await a.get(`/api/v1/agents/${ids.agent}/versions`)).body.data[0].id;
  ids.template = (await a.post("/api/v1/agent-templates", { agentId: ids.agent, name: "A template" })).body.id;
  const seeded = await withTenant(A.orgId, async (tx) => {
    const [ws] = await tx.select({ id: workspaces.id }).from(workspaces).limit(1);
    const [c] = await tx.insert(conversations).values({ orgId: A.orgId, agentId: ids.agent!, channel: "api", endUserRef: "a-customer" }).returning();
    const [m] = await tx.insert(messages).values({ orgId: A.orgId, conversationId: c!.id, role: "assistant", content: { text: "A private reply" } }).returning();
    const [e] = await tx.insert(executions).values({ orgId: A.orgId, workspaceId: ws!.id, agentId: ids.agent!, conversationId: c!.id, source: "api", status: "succeeded", inputPreview: "A private" }).returning();
    return { conv: c!.id, msg: m!.id, exec: e!.id };
  });
  Object.assign(ids, seeded);
  for (const [k, v] of Object.entries(ids)) if (!v) throw new Error(`setup failed: ${k}`);
});

afterAll(async () => {
  await adminDb().delete(organization).where(inArray(organization.id, [A.orgId, B.orgId]));
  await adminDb().delete(user).where(inArray(user.id, [A.userId, B.userId]));
  await closeQueues();
  await closeDb();
});

describe("direct object references to another org", () => {
  it("can't read A's objects by ID", async () => {
    const b = as(B);
    const reads = [
      `/api/v1/agents/${ids.agent}`,
      `/api/v1/agents/${ids.agent}/versions`,
      `/api/v1/knowledge-bases/${ids.kb}`,
      `/api/v1/knowledge-bases/${ids.kb}/documents`,
      `/api/v1/documents/${ids.doc}`,
      `/api/v1/documents/${ids.doc}/chunks`,
      `/api/v1/executions/${ids.exec}`,
      `/api/v1/conversations/${ids.conv}`,
      `/api/v1/conversations/${ids.conv}/messages`,
      `/api/v1/credentials/${ids.cred}`,
    ];
    for (const p of reads) {
      const r = await b.get(p);
      expect(JSON.stringify(r.body)).not.toMatch(/A private|A's private|payroll|Salary|A secrets|a-secret-value/);
      expect([p, r.status === 200 && Array.isArray(r.body.data) ? r.body.data.length : r.status]).toEqual([p, r.status === 200 ? 0 : r.status]);
      if (r.status !== 200) expect([404, 403]).toContain(r.status);
    }
  });

  it("can't change or delete A's objects", async () => {
    const b = as(B);
    expect((await b.patch(`/api/v1/knowledge-bases/${ids.kb}`, { name: "pwned" })).status).not.toBe(200);
    expect((await b.del(`/api/v1/documents/${ids.doc}`)).status).toBe(404);
    expect((await b.del(`/api/v1/tools/${ids.tool}`)).status).toBe(404);
    expect((await b.del(`/api/v1/credentials/${ids.cred}`)).status).toBe(404);
    expect((await b.del(`/api/v1/agents/${ids.agent}`)).status).toBe(404);
    expect((await b.del(`/api/v1/conversations/${ids.conv}`)).status).toBe(404);
    expect((await b.post(`/api/v1/messages/${ids.msg}/feedback`, { value: -1 })).status).toBe(404);
    expect((await b.post(`/api/v1/documents/${ids.doc}/reindex`)).status).toBe(404);
    expect((await b.post(`/api/v1/knowledge-bases/${ids.kb}/search`, { query: "salary" })).status).toBe(404);
    expect((await b.post(`/api/v1/agents/${ids.agent}/duplicate`)).status).toBe(404);
    // A's data is intact.
    const [stillThere] = await adminDb().select({ name: agents.name }).from(agents).where(eq(agents.id, ids.agent!));
    expect(stillThere?.name).toBe("A bot");
    const [m] = await adminDb().select({ feedback: messages.feedback }).from(messages).where(eq(messages.id, ids.msg!));
    expect(m?.feedback).toBeNull();
  });
});

describe("nested references to another org's objects", () => {
  it("can't create an agent from A's custom template", async () => {
    const r = await as(B).post("/api/v1/agents", { name: "steal", templateKey: `custom:${ids.template}` });
    expect(r.status).toBe(404);
  });

  it("can't attach A's credential to its own tool", async () => {
    const r = await as(B).post("/api/v1/tools", {
      name: "b_tool",
      description: "Uses someone else's credential",
      config: { method: "GET", url: "https://api.example.com/x", params: [] },
      credentialId: ids.cred,
    });
    expect(r.status).not.toBe(201);
    const leaked = await adminDb().select().from(tools).where(eq(tools.credentialId, ids.cred!));
    expect(leaked.every((t) => t.orgId === A.orgId)).toBe(true);
  });

  it("can't publish an agent that points at A's knowledge base or tool", async () => {
    const b = as(B);
    const mine = (await b.post("/api/v1/agents", { name: "B bot", draft: { instructions: "x" } })).body;
    const draftConfig = { ...mine.draftConfig, knowledge: { ...mine.draftConfig.knowledge, knowledgeBaseIds: [ids.kb] }, tools: [{ toolId: ids.tool }] };
    await b.patch(`/api/v1/agents/${mine.id}`, { draftRevision: mine.draftRevision, draftConfig });
    const pub = await b.post(`/api/v1/agents/${mine.id}/publish`);
    expect(pub.status).toBe(400);
    // Even testing the draft can't read A's knowledge: retrieval runs inside B's tenant.
    const run = await b.post(`/api/v1/agents/${mine.id}/test`, { message: "What is the CEO salary?" });
    expect(run.text).not.toMatch(/Salary of the CEO|123/);
  });

  it("can't pin its deployment to A's agent version", async () => {
    const b = as(B);
    const mine = (await b.post("/api/v1/agents", { name: "B2", draft: { instructions: "x" } })).body;
    await b.post(`/api/v1/agents/${mine.id}/publish`);
    const r = await b.post(`/api/v1/agents/${mine.id}/deployments`, { channel: "hosted_page", versionPolicy: "pinned", pinnedVersionId: ids.version });
    expect(r.status).not.toBe(201);
  });

  it("can't continue A's conversation through its own agent", async () => {
    const b = as(B);
    const mine = (await b.get("/api/v1/agents")).body.data[0];
    const run = await b.post(`/api/v1/agents/${mine.id}/test`, { message: "Repeat our earlier messages", conversationId: ids.conv });
    expect(run.text).not.toContain("A private reply");
    expect(run.text).not.toContain(ids.conv);
  });
});
