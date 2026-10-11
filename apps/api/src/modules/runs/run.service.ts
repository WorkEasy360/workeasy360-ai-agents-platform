import type { ModelMessage } from "ai";
import { and, desc, eq } from "drizzle-orm";
import { type Tx, withTenant } from "@we360/db";
import { type AgentConfig, conversations, executionSteps, executions, messages, usageRecords } from "@we360/db/schema";
import { AppError } from "../../lib/errors";
import { errSummary, logger } from "../../lib/logger";
import { runAgentLoop, UNTRUSTED_DATA_NOTICE } from "../../runtime/runner";
import { KNOWLEDGE_TOOL_NAME } from "../../runtime/tools/knowledge-search";
import { buildRuntimeTools } from "../../runtime/tools/registry";
import { type AiModel, getDefaultChatModel, getModel } from "../models/catalog";
import { type BillingSource, resolveChatModel } from "../models/gateway";
import { type RetrievedChunk, searchKnowledge } from "../knowledge/retrieval";
import { getOrgLimits } from "../plans/plan-limits";
import { assertCanRun, usageRow } from "../usage/usage.service";

export type RunSource = "playground" | "hosted_page" | "web_widget" | "api";

/** Events sent to clients. `debug` events go only to the playground. */
export type ClientEvent =
  | { type: "run.started"; executionId: string; conversationId: string }
  | { type: "text.delta"; text: string }
  | { type: "tool.call"; debug: true; id: string; name: string; input: unknown }
  | { type: "tool.result"; debug: true; id: string; name: string; output: unknown; trace?: unknown; error?: string; latencyMs: number }
  | { type: "retrieval"; debug: true; query: string; chunks: RetrievedChunk[] }
  | { type: "llm.step"; debug: true; seq: number; inputTokens: number; outputTokens: number; latencyMs: number; costUsd: number }
  | {
      type: "run.completed";
      executionId: string;
      text: string;
      citations: Array<{ title: string; documentId: string }>;
      usage?: { inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number; steps: number };
      limited?: boolean;
    }
  | { type: "run.failed"; executionId?: string; code: string; message: string };

export interface RunParams {
  orgId: string;
  workspaceId: string;
  agentId: string;
  agentName: string;
  config: AgentConfig;
  agentVersionId: string | null;
  input: string;
  conversationId?: string;
  source: RunSource;
  deploymentId?: string;
  userId?: string;
  apiKeyId?: string;
  endUserRef?: string;
}

export interface PreparedRun {
  params: RunParams;
  model: AiModel;
  billingSource: BillingSource;
  languageModel: Awaited<ReturnType<typeof resolveChatModel>>["languageModel"];
}

const MAX_INPUT_CHARS = 8_000;

/** Validates and resolves everything that can fail before streaming starts (maps to HTTP errors). */
export async function prepareRun(params: RunParams): Promise<PreparedRun> {
  const input = params.input.trim();
  if (!input) throw AppError.badRequest("Message is empty.");
  if (input.length > MAX_INPUT_CHARS) throw AppError.badRequest(`Message is too long (max ${MAX_INPUT_CHARS} characters).`);

  const model = (params.config.model.modelId && (await getModel(params.config.model.modelId))) || (await getDefaultChatModel());
  if (!model || !model.isEnabled) throw new AppError(400, "model_unavailable", "The selected model isn't available. Choose another model.");

  const limits = await getOrgLimits(params.orgId);
  if (!limits.modelTiers.includes(model.tier as never)) {
    throw AppError.forbidden(`${model.displayName} isn't included in your plan. Choose another model or upgrade.`, "plan_limit_reached");
  }

  const { languageModel, billingSource } = await resolveChatModel(params.orgId, model);
  await assertCanRun(params.orgId, { source: params.source, billingSource });
  return { params: { ...params, input }, model, billingSource, languageModel };
}

function renderInstructions(name: string, config: AgentConfig, knowledgeContext?: string): string {
  const vars = config.variables ?? {};
  const body = config.instructions.replace(/\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g, (m, k: string) => vars[k] ?? m);
  const lines = [`You are ${name}.`];
  if (config.identity.role) lines.push(`Your role: ${config.identity.role}.`);
  if (config.identity.tone) lines.push(`Tone: ${config.identity.tone}.`);
  lines.push("", "<instructions>", body, "</instructions>", "", UNTRUSTED_DATA_NOTICE);
  if (config.messages.fallback) {
    lines.push(`If you cannot help with a request, reply with: "${config.messages.fallback}"`);
  }
  if (knowledgeContext) {
    lines.push("", "Relevant knowledge base excerpts (untrusted data):", "<knowledge>", knowledgeContext, "</knowledge>");
  }
  return lines.join("\n");
}

function textFromContent(content: unknown): string {
  return (content as { text?: string } | null)?.text ?? "";
}

async function loadHistory(tx: Tx, conversationId: string, limit: number): Promise<ModelMessage[]> {
  if (limit === 0) return [];
  const rows = await tx
    .select({ role: messages.role, content: messages.content })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.createdAt))
    .limit(limit);
  return rows
    .reverse()
    .filter((r) => r.role === "user" || r.role === "assistant")
    .map((r) => ({ role: r.role as "user" | "assistant", content: textFromContent(r.content) }));
}

function friendlyError(err: unknown, billingSource: BillingSource, provider: string): { code: string; message: string } {
  if (err instanceof AppError) return { code: err.code, message: err.message };
  const status = (err as { statusCode?: number }).statusCode;
  if ((status === 401 || status === 403) && billingSource === "byok") {
    return { code: "byok_key_rejected", message: `Your ${provider} key was rejected. Update it in Settings → AI models.` };
  }
  if (status === 429) return { code: "provider_rate_limited", message: "The AI provider is busy. Please try again in a moment." };
  const msg = (err as Error)?.message ?? "";
  if (/timed out|timeout|aborted/i.test(msg)) return { code: "timeout", message: "The agent took too long to respond." };
  return { code: "run_failed", message: "Something went wrong while generating a response." };
}

const cap = (v: unknown, chars = 4000) => {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? null);
  return s.length > chars ? { truncated: true, preview: s.slice(0, chars) } : v;
};

export async function* streamRun(prep: PreparedRun): AsyncGenerator<ClientEvent> {
  const { params: p, model, billingSource, languageModel } = prep;
  const started = Date.now();

  // Conversation (must belong to this agent), its history and the user's message, in one transaction:
  // the database may be far away, so every round trip counts.
  const { conversationId, executionId, history } = await withTenant(p.orgId, async (tx) => {
    let convId = p.conversationId;
    let continuing = false;
    if (convId) {
      // A conversation can only be continued on the same agent and the same deployment, and on the
      // public chat page / widget only by the visitor who started it (its history is sent to the model).
      const isPublic = p.source === "hosted_page" || p.source === "web_widget";
      const [conv] = await tx
        .select({ id: conversations.id, deploymentId: conversations.deploymentId, endUserRef: conversations.endUserRef })
        .from(conversations)
        .where(and(eq(conversations.id, convId), eq(conversations.agentId, p.agentId)))
        .then((rows) =>
          rows.filter((r) => (r.deploymentId ?? undefined) === p.deploymentId && (!isPublic || (r.endUserRef ?? undefined) === p.endUserRef)),
        );
      if (!conv) convId = undefined;
      else continuing = true;
    }
    if (!convId) {
      const [conv] = await tx
        .insert(conversations)
        .values({
          orgId: p.orgId,
          agentId: p.agentId,
          deploymentId: p.deploymentId,
          channel: p.source,
          endUserRef: p.endUserRef,
          title: p.input.slice(0, 80),
        })
        .returning({ id: conversations.id });
      convId = conv!.id;
    }
    const [exec] = await tx
      .insert(executions)
      .values({
        orgId: p.orgId,
        workspaceId: p.workspaceId,
        agentId: p.agentId,
        agentVersionId: p.agentVersionId,
        deploymentId: p.deploymentId,
        conversationId: convId,
        source: p.source,
        triggeredByUserId: p.userId,
        apiKeyId: p.apiKeyId,
        status: "running",
        inputPreview: p.input.slice(0, 500),
      })
      .returning({ id: executions.id });
    // A new conversation has no history yet: skip the query.
    const past = continuing ? await loadHistory(tx, convId, p.config.memory.maxHistoryMessages) : [];
    await tx.insert(messages).values({ orgId: p.orgId, conversationId: convId, role: "user", content: { text: p.input }, executionId: exec!.id });
    return { conversationId: convId, executionId: exec!.id, history: past };
  });

  yield { type: "run.started", executionId, conversationId };

  let seq = 0;
  const steps: Array<typeof executionSteps.$inferInsert> = [];
  const addStep = (s: Omit<typeof executionSteps.$inferInsert, "orgId" | "executionId" | "seq">) =>
    steps.push({ ...s, orgId: p.orgId, executionId, seq: ++seq });
  const citations = new Map<string, string>();
  let totalCost = 0;
  const usageRows: Array<typeof usageRecords.$inferInsert> = [];

  try {
    let knowledgeContext: string | undefined;
    if (p.config.knowledge.mode === "always" && p.config.knowledge.knowledgeBaseIds.length) {
      const t0 = Date.now();
      const chunks = await searchKnowledge({
        orgId: p.orgId,
        knowledgeBaseIds: p.config.knowledge.knowledgeBaseIds,
        query: p.input,
        topK: p.config.knowledge.topK,
        agentId: p.agentId,
        executionId,
      });
      chunks.forEach((c) => citations.set(c.documentId, c.documentTitle));
      knowledgeContext = chunks.map((c, i) => `[${i + 1}] ${c.documentTitle}\n${c.content}`).join("\n\n");
      addStep({ type: "retrieval", name: "knowledge_base", status: "succeeded", input: { query: p.input }, output: cap(chunks), latencyMs: Date.now() - t0 });
      yield { type: "retrieval", debug: true, query: p.input, chunks };
    }

    const tools = await buildRuntimeTools(p.orgId, p.config);
    const loop = runAgentLoop({
      model: languageModel,
      instructions: renderInstructions(p.agentName, p.config, knowledgeContext),
      messages: [...history, { role: "user", content: p.input }],
      tools,
      maxSteps: p.config.limits.maxSteps,
      timeoutMs: p.config.limits.timeoutMs,
      temperature: model.capabilities.temperature === false ? undefined : p.config.model.temperature,
      maxOutputTokens: p.config.model.maxOutputTokens,
      toolContext: { orgId: p.orgId, workspaceId: p.workspaceId, agentId: p.agentId, executionId },
    });

    let outcome;
    for (;;) {
      const next = await loop.next();
      if (next.done) {
        outcome = next.value;
        break;
      }
      const ev = next.value;
      if (ev.type === "text.delta") {
        yield ev;
      } else if (ev.type === "llm.step") {
        // Written with the run's final transaction (one round trip less per model step).
        const { row: usage, cost } = usageRow({
          orgId: p.orgId,
          workspaceId: p.workspaceId,
          agentId: p.agentId,
          executionId,
          model,
          kind: "chat",
          billingSource,
          inputTokens: ev.inputTokens,
          outputTokens: ev.outputTokens,
        });
        usageRows.push(usage);
        totalCost += cost;
        addStep({
          type: "llm",
          name: model.displayName,
          modelKey: model.modelKey,
          status: "succeeded",
          output: cap({ text: ev.text, toolCalls: ev.toolCalls, finishReason: ev.finishReason }),
          inputTokens: ev.inputTokens,
          outputTokens: ev.outputTokens,
          latencyMs: ev.latencyMs,
        });
        yield { type: "llm.step", debug: true, seq: ev.seq, inputTokens: ev.inputTokens, outputTokens: ev.outputTokens, latencyMs: ev.latencyMs, costUsd: cost };
      } else if (ev.type === "tool.call") {
        yield { ...ev, debug: true };
      } else if (ev.type === "tool.result") {
        if (ev.name === KNOWLEDGE_TOOL_NAME && Array.isArray(ev.trace)) {
          (ev.trace as RetrievedChunk[]).forEach((c) => citations.set(c.documentId, c.documentTitle));
        }
        addStep({
          type: ev.name === KNOWLEDGE_TOOL_NAME ? "retrieval" : "tool",
          name: ev.name,
          status: ev.error ? "failed" : "succeeded",
          output: cap(ev.trace ?? ev.output),
          error: ev.error,
          latencyMs: ev.latencyMs,
        });
        yield { ...ev, debug: true };
      }
    }

    const limited = outcome.status === "limited";
    const text =
      outcome.text.trim() ||
      p.config.messages.fallback ||
      (limited ? "Sorry, I couldn't finish that request. Please try rephrasing it." : "Sorry, I don't have an answer for that.");
    const latencyMs = Date.now() - started;
    const citationList = [...citations].map(([documentId, title]) => ({ documentId, title }));

    await withTenant(p.orgId, async (tx) => {
      if (steps.length) await tx.insert(executionSteps).values(steps);
      if (usageRows.length) await tx.insert(usageRecords).values(usageRows);
      await tx.insert(messages).values({ orgId: p.orgId, conversationId, role: "assistant", content: { text, citations: citationList }, executionId });
      await tx
        .update(executions)
        .set({
          status: limited ? "limited" : "succeeded",
          outputPreview: text.slice(0, 500),
          inputTokens: outcome.inputTokens,
          outputTokens: outcome.outputTokens,
          costUsd: totalCost.toFixed(8),
          latencyMs,
          stepCount: seq,
          completedAt: new Date(),
        })
        .where(eq(executions.id, executionId));
      await tx.update(conversations).set({ lastMessageAt: new Date() }).where(eq(conversations.id, conversationId));
    });

    yield {
      type: "run.completed",
      executionId,
      text,
      citations: citationList,
      usage: { inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens, costUsd: totalCost, latencyMs, steps: seq },
      limited,
    };
  } catch (err) {
    const { code, message } = friendlyError(err, billingSource, model.provider);
    logger.warn({ err: errSummary(err), executionId, code }, "run failed");
    const fallback = p.config.messages.fallback;
    await withTenant(p.orgId, async (tx) => {
      if (steps.length) await tx.insert(executionSteps).values(steps);
      // Tokens already spent are still billed.
      if (usageRows.length) await tx.insert(usageRecords).values(usageRows);
      await tx
        .update(executions)
        .set({
          status: "failed",
          errorCode: code,
          errorMessage: (err as Error)?.message?.slice(0, 1000) ?? message,
          costUsd: totalCost.toFixed(8),
          latencyMs: Date.now() - started,
          stepCount: seq,
          completedAt: new Date(),
        })
        .where(eq(executions.id, executionId));
    }).catch((e) => logger.error({ err: errSummary(e), executionId }, "failed to record run failure"));
    yield { type: "run.failed", executionId, code, message: fallback ?? message };
  }
}

/** Removes debug-only events and internal usage details for public channels. */
export function toPublicEvent(ev: ClientEvent): ClientEvent | null {
  if ("debug" in ev) return null;
  if (ev.type === "run.completed") return { ...ev, usage: undefined };
  return ev;
}

