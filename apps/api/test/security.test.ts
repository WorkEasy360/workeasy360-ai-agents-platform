import { createDeflateRaw, crc32 } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import { eq, inArray, sql } from "drizzle-orm";
import { adminDb, closeDb, withTenant } from "@we360/db";
import { agents, conversations, organization, user } from "@we360/db/schema";
import { closeQueues } from "../src/lib/queue";
import { DocumentTooLargeError, parseDocumentIsolated } from "../src/modules/knowledge/parsers";
import { buildHttpTool, httpConfigSchema } from "../src/runtime/tools/http-request";
import { ORIGIN, app, signUpWithOrg } from "./helpers";

const cleanup: Array<{ orgId: string; userId: string }> = [];
afterAll(async () => {
  await adminDb().delete(organization).where(inArray(organization.id, cleanup.map((c) => c.orgId)));
  await adminDb().delete(user).where(inArray(user.id, cleanup.map((c) => c.userId)));
  await closeQueues();
  await closeDb();
});

describe("Custom API tool: the model can't redirect requests", () => {
  const tool = (url: string, params: string[]) =>
    buildHttpTool({
      name: "lookup",
      description: "d",
      config: { method: "GET", url, headers: {}, params: params.map((name) => ({ name, type: "string", description: "", required: true })), timeoutMs: 1000 },
      sideEffect: "read",
      requiresApproval: false,
      auth: { authType: "bearer", secret: "test-secret", headerName: undefined },
    });

  it("rejects placeholders in the host when the tool is saved", () => {
    expect(httpConfigSchema.safeParse({ method: "GET", url: "https://api.example.{tld}/v1" }).success).toBe(false);
    expect(httpConfigSchema.safeParse({ method: "GET", url: "https://{host}/v1" }).success).toBe(false);
    expect(httpConfigSchema.safeParse({ method: "GET", url: "https://api.example.com/v1/{id}?q={q}" }).success).toBe(true);
  });

  it("refuses to run a previously saved tool whose host has a placeholder", async () => {
    const out = await tool("https://api.example.{tld}/v1", ["tld"]).execute({ tld: "com.attacker.test" }, {} as never);
    expect(out.forModel).toMatchObject({ ok: false });
    expect(JSON.stringify(out)).not.toContain("attacker.test");
  });

  it("refuses '.' and '..' path values", async () => {
    for (const id of [".", ".."]) {
      const out = await tool("https://api.example.com/v1/customers/{id}/orders", ["id"]).execute({ id }, {} as never);
      expect(out.forModel).toMatchObject({ ok: false });
    }
  });
});

/** Minimal single-entry zip writer: streams a highly compressible payload so the test stays small. */
async function bombDocx(expandedBytes: number): Promise<Buffer> {
  const deflate = createDeflateRaw({ level: 9 });
  const parts: Buffer[] = [];
  deflate.on("data", (b: Buffer) => parts.push(b));
  const head = Buffer.from('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>');
  const tail = Buffer.from("</w:body></w:document>");
  const para = Buffer.from("<w:p><w:r><w:t>aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa</w:t></w:r></w:p>".repeat(2000));
  let crc = crc32(head);
  deflate.write(head);
  let size = head.length;
  while (size < expandedBytes) {
    crc = crc32(para, crc);
    size += para.length;
    if (!deflate.write(para)) await new Promise((r) => deflate.once("drain", r));
  }
  crc = crc32(tail, crc);
  size += tail.length;
  const ended = new Promise<void>((r) => deflate.once("end", () => r()));
  deflate.end(tail);
  await ended; // all compressed output has been emitted
  const data = Buffer.concat(parts);
  const name = Buffer.from("word/document.xml");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc >>> 0, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(size, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc >>> 0, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(size, 24);
  central.writeUInt16LE(name.length, 28);
  const cdOffset = local.length + name.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

describe("document parsing is isolated", () => {
  it("contains a decompression bomb to its own process", async () => {
    const bomb = await bombDocx(200_000_000); // under 1 MB on disk
    expect(bomb.length).toBeLessThan(2_000_000);
    await expect(parseDocumentIsolated(bomb, "docx", { maxHeapMb: 128 })).rejects.toBeInstanceOf(DocumentTooLargeError);
    // This process is unaffected.
    expect(process.memoryUsage().heapUsed).toBeLessThan(1_000_000_000);
  }, 60_000);
});

describe("plan limits under concurrency", () => {
  let who: Awaited<ReturnType<typeof signUpWithOrg>>;
  beforeAll(async () => {
    who = await signUpWithOrg("sec-race");
    cleanup.push(who);
  });

  it("creates only as many agents as the plan allows, even in parallel", async () => {
    const statuses = await Promise.all(
      Array.from({ length: 8 }, (_, i) => who.agent.post("/api/v1/agents").set("Origin", ORIGIN).set("x-org-id", who.orgId).send({ name: `R${i}` }).then((r) => r.status)),
    );
    const created = await withTenant(who.orgId, (tx) => tx.select({ id: agents.id }).from(agents));
    expect(created).toHaveLength(1); // free plan: 1 agent
    expect(statuses.filter((s) => s === 201)).toHaveLength(1);
  });
});

describe("public conversations", () => {
  it("can't be continued by a different visitor", async () => {
    const who = await signUpWithOrg("sec-conv");
    cleanup.push(who);
    const a = await who.agent.post("/api/v1/agents").set("Origin", ORIGIN).set("x-org-id", who.orgId).send({ name: "Bot", draft: { instructions: "Be nice." } });
    await who.agent.post(`/api/v1/agents/${a.body.id}/publish`).set("Origin", ORIGIN).set("x-org-id", who.orgId).send({});
    const dep = await who.agent.post(`/api/v1/agents/${a.body.id}/deployments`).set("Origin", ORIGIN).set("x-org-id", who.orgId).send({ channel: "hosted_page" });
    const send = (visitorId: string, conversationId?: string) =>
      request(app).post(`/api/public/v1/deployments/${dep.body.publicKey}/messages`).send({ message: "hello", visitorId, conversationId });
    const conversationOf = (sse: string) => /"conversationId":"([0-9a-f-]{36})"/.exec(sse)?.[1];

    const first = conversationOf((await send("visitor-a")).text);
    expect(first).toBeDefined();
    expect(conversationOf((await send("visitor-a", first)).text)).toBe(first);
    const other = conversationOf((await send("visitor-b", first)).text);
    expect(other).toBeDefined();
    expect(other).not.toBe(first);
    const [conv] = await withTenant(who.orgId, (tx) => tx.select().from(conversations).where(eq(conversations.id, other!)));
    expect(conv?.endUserRef).toBe("visitor-b");
  });
});

describe("cross-site requests", () => {
  it("rejects state-changing calls from another origin", async () => {
    const who = await signUpWithOrg("sec-csrf");
    cleanup.push(who);
    const blocked = await who.agent.post("/api/v1/agents").set("Origin", "https://other.workeasy360.com").set("x-org-id", who.orgId).send({ name: "x" });
    expect([blocked.status, blocked.body.code]).toEqual([403, "cross_site_request"]);
    const ok = await who.agent.post("/api/v1/agents").set("Origin", ORIGIN).set("x-org-id", who.orgId).send({ name: "x" });
    expect(ok.status).toBe(201);
  });
});

describe("organization farming", () => {
  it("allows one free organization per user, even with parallel requests", async () => {
    const who = await signUpWithOrg("sec-orgs"); // already owns one free org
    cleanup.push(who);
    const statuses = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        who.agent.post("/api/auth/organization/create").set("Origin", ORIGIN).send({ name: `extra ${i}`, slug: `sec-orgs-${who.userId.slice(0, 8)}-${i}` }).then((r) => r.status),
      ),
    );
    expect(statuses.every((s) => s === 403)).toBe(true);
  });

  it("caps a burst from a user with no organization yet", async () => {
    const agent = request.agent(app);
    const email = `sec-burst-${Date.now()}@test.local`;
    const su = await agent.post("/api/auth/sign-up/email").set("Origin", ORIGIN).send({ email, password: "correct-horse-battery", name: "burst" });
    const statuses = await Promise.all(
      Array.from({ length: 8 }, (_, i) => agent.post("/api/auth/organization/create").set("Origin", ORIGIN).send({ name: `b${i}`, slug: `sec-burst-${Date.now()}-${i}` }).then((r) => r.status)),
    );
    expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(3);
    const mine = await adminDb().execute<{ id: string }>(sql`select organization_id as id from member where user_id = ${su.body.user.id}`);
    for (const r of mine.rows) cleanup.push({ orgId: r.id, userId: su.body.user.id });
    if (!mine.rows.length) cleanup.push({ orgId: "00000000-0000-4000-8000-000000000000", userId: su.body.user.id });
  });
});

describe("per-account sign-in throttling", () => {
  it("pauses sign-in for an account after 10 failed passwords, whatever the IP", async () => {
    const who = await signUpWithOrg("sec-lock");
    cleanup.push(who);
    for (let i = 0; i < 10; i++) {
      const r = await request(app).post("/api/auth/sign-in/email").set("Origin", ORIGIN).set("X-Forwarded-For", `203.0.113.${i + 1}`).send({ email: who.email, password: `wrong-password-${i}` });
      expect(r.status).toBe(401);
    }
    const locked = await request(app).post("/api/auth/sign-in/email").set("Origin", ORIGIN).send({ email: who.email, password: "correct-horse-battery" });
    expect(locked.status).toBe(429);
    // Other accounts are unaffected.
    const other = await signUpWithOrg("sec-lock-other");
    cleanup.push(other);
    const ok = await request(app).post("/api/auth/sign-in/email").set("Origin", ORIGIN).send({ email: other.email, password: "correct-horse-battery" });
    expect(ok.status).toBe(200);
  });
});

describe("public endpoints", () => {
  it("don't reveal the customer's plan", async () => {
    const who = await signUpWithOrg("sec-pub");
    cleanup.push(who);
    const a = await who.agent.post("/api/v1/agents").set("Origin", ORIGIN).set("x-org-id", who.orgId).send({ name: "Bot", draft: { instructions: "Be nice." } });
    await who.agent.post(`/api/v1/agents/${a.body.id}/publish`).set("Origin", ORIGIN).set("x-org-id", who.orgId).send({});
    const dep = await who.agent.post(`/api/v1/agents/${a.body.id}/deployments`).set("Origin", ORIGIN).set("x-org-id", who.orgId).send({ channel: "hosted_page" });
    const pub = await request(app).get(`/api/public/v1/deployments/${dep.body.publicKey}`);
    expect(pub.status).toBe(200);
    expect(pub.body).not.toHaveProperty("plan");
  });
});
