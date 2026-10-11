import { Router } from "express";
import { and, asc, desc, eq, lt, type SQL } from "drizzle-orm";
import { z } from "zod";
import { withTenant } from "@we360/db";
import { agents, conversations, executionSteps, executions, messages } from "@we360/db/schema";
import { AppError } from "../../lib/errors";
import { audit, parse, tenantOf, uuidParam } from "../../lib/http";
import { requireRole, requireSession, requireTenant } from "../../middleware/auth";
import { eraseConversations } from "../privacy/privacy.service";

/** Execution logs and conversations. Cursor pagination on started_at / last_message_at. */
export const executionsRouter = Router();
// Scoped to its own paths: this router is mounted at /api/v1 alongside others.
executionsRouter.use(["/executions", "/conversations", "/messages"], requireSession, requireTenant);

const listSchema = z.object({
  agentId: z.uuid().optional(),
  status: z.enum(["running", "succeeded", "failed", "limited"]).optional(),
  source: z.enum(["playground", "hosted_page", "web_widget", "api"]).optional(),
  cursor: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

executionsRouter.get("/executions", async (req, res) => {
  const { orgId } = tenantOf(req);
  const q = parse(listSchema, req.query);
  const where: SQL[] = [];
  if (q.agentId) where.push(eq(executions.agentId, q.agentId));
  if (q.status) where.push(eq(executions.status, q.status));
  if (q.source) where.push(eq(executions.source, q.source));
  if (q.cursor) where.push(lt(executions.startedAt, new Date(q.cursor)));
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select({
        id: executions.id,
        agentId: executions.agentId,
        agentName: agents.name,
        source: executions.source,
        status: executions.status,
        errorCode: executions.errorCode,
        inputPreview: executions.inputPreview,
        outputPreview: executions.outputPreview,
        inputTokens: executions.inputTokens,
        outputTokens: executions.outputTokens,
        costUsd: executions.costUsd,
        latencyMs: executions.latencyMs,
        startedAt: executions.startedAt,
      })
      .from(executions)
      .leftJoin(agents, eq(agents.id, executions.agentId))
      .where(and(...where))
      .orderBy(desc(executions.startedAt))
      .limit(q.limit + 1),
  );
  const page = rows.slice(0, q.limit);
  res.json({ data: page, nextCursor: rows.length > q.limit ? page.at(-1)!.startedAt.toISOString() : null });
});

executionsRouter.get("/executions/:id", async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  const result = await withTenant(orgId, async (tx) => {
    const [exec] = await tx
      .select({ execution: executions, agentName: agents.name })
      .from(executions)
      .leftJoin(agents, eq(agents.id, executions.agentId))
      .where(eq(executions.id, id));
    if (!exec) return undefined;
    const steps = await tx.select().from(executionSteps).where(eq(executionSteps.executionId, id)).orderBy(asc(executionSteps.seq));
    return { ...exec.execution, agentName: exec.agentName, steps };
  });
  if (!result) throw AppError.notFound("Execution");
  res.json(result);
});

executionsRouter.get("/conversations", async (req, res) => {
  const { orgId } = tenantOf(req);
  const q = parse(z.object({ agentId: z.uuid().optional(), cursor: z.iso.datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }), req.query);
  const where: SQL[] = [];
  if (q.agentId) where.push(eq(conversations.agentId, q.agentId));
  if (q.cursor) where.push(lt(conversations.createdAt, new Date(q.cursor)));
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select({
        id: conversations.id,
        agentId: conversations.agentId,
        agentName: agents.name,
        channel: conversations.channel,
        title: conversations.title,
        endUserRef: conversations.endUserRef,
        lastMessageAt: conversations.lastMessageAt,
        createdAt: conversations.createdAt,
      })
      .from(conversations)
      .leftJoin(agents, eq(agents.id, conversations.agentId))
      .where(and(...where))
      .orderBy(desc(conversations.createdAt))
      .limit(q.limit + 1),
  );
  const page = rows.slice(0, q.limit);
  res.json({ data: page, nextCursor: rows.length > q.limit ? page.at(-1)!.createdAt.toISOString() : null });
});

executionsRouter.get("/conversations/:id", async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  const [row] = await withTenant(orgId, (tx) =>
    tx
      .select({
        id: conversations.id,
        agentId: conversations.agentId,
        agentName: agents.name,
        channel: conversations.channel,
        title: conversations.title,
        endUserRef: conversations.endUserRef,
        lastMessageAt: conversations.lastMessageAt,
        createdAt: conversations.createdAt,
      })
      .from(conversations)
      .leftJoin(agents, eq(agents.id, conversations.agentId))
      .where(eq(conversations.id, id)),
  );
  if (!row) throw AppError.notFound("Conversation");
  res.json(row);
});

/** Deletes one conversation with its messages and run logs (e.g. for an end user's erasure request). */
executionsRouter.delete("/conversations/:id", requireRole("admin"), async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  const erased = await withTenant(orgId, async (tx) => {
    const result = await eraseConversations(tx, eq(conversations.id, id));
    if (result.conversations) await audit(req, { action: "conversation.deleted", targetType: "conversation", targetId: id, diff: result }, tx);
    return result;
  });
  if (!erased.conversations) throw AppError.notFound("Conversation");
  res.status(204).end();
});

executionsRouter.get("/conversations/:id/messages", async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select({ id: messages.id, role: messages.role, content: messages.content, executionId: messages.executionId, feedback: messages.feedback, createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(asc(messages.createdAt))
      .limit(500),
  );
  res.json({ data: rows });
});

executionsRouter.post("/messages/:id/feedback", async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  const { value } = parse(z.object({ value: z.union([z.literal(1), z.literal(-1), z.null()]) }), req.body);
  const [row] = await withTenant(orgId, (tx) =>
    tx.update(messages).set({ feedback: value }).where(and(eq(messages.id, id), eq(messages.role, "assistant"))).returning({ id: messages.id }),
  );
  if (!row) throw AppError.notFound("Message");
  res.json({ ok: true });
});
