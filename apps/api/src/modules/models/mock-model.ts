import type { LanguageModelV4, LanguageModelV4StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";

/**
 * Local-development model used when MOCK_LLM=true (no provider keys needed).
 * Behaves like a real tool-calling model so the whole run pipeline can be exercised:
 * if a `knowledge_search` tool is available and hasn't been called for the latest user
 * message, it calls it; otherwise it streams a short reply that quotes any tool results.
 * Never enabled in production.
 */

interface PromptMessage {
  role: string;
  content: unknown;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p: { type?: string; text?: string; output?: { value?: unknown } }) => {
      if (p.type === "text") return p.text ?? "";
      if (p.type === "tool-result") {
        const v = p.output?.value;
        return typeof v === "string" ? v : JSON.stringify(v);
      }
      return "";
    })
    .join(" ");
}

function streamOf(parts: LanguageModelV4StreamPart[]): ReadableStream<LanguageModelV4StreamPart> {
  return new ReadableStream({
    async start(controller) {
      for (const part of parts) {
        controller.enqueue(part);
        if (part.type === "text-delta") await new Promise((r) => setTimeout(r, 15));
      }
      controller.close();
    },
  });
}

const usage = (inTok: number, outTok: number) => ({
  inputTokens: { total: inTok, noCache: inTok, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: outTok, text: outTok, reasoning: 0 },
});

export function createMockModel(modelId: string): LanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock",
    modelId,
    doStream: async (options) => {
      const prompt = options.prompt as PromptMessage[];
      const lastUserIdx = prompt.map((m) => m.role).lastIndexOf("user");
      const userText = textOf(prompt[lastUserIdx]?.content).trim();
      const toolResults = prompt.slice(lastUserIdx + 1).filter((m) => m.role === "tool");
      const tools = (options.tools ?? []).filter((t) => t.type === "function");
      const inTok = Math.ceil(JSON.stringify(prompt).length / 4);

      const kb = tools.find((t) => t.name === "knowledge_search");
      if (kb && toolResults.length === 0 && userText) {
        return {
          stream: streamOf([
            { type: "stream-start", warnings: [] },
            { type: "tool-call", toolCallId: `call_${Date.now()}`, toolName: kb.name, input: JSON.stringify({ query: userText }) },
            { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: usage(inTok, 12) },
          ]),
        };
      }

      const found = toolResults.map((m) => textOf(m.content)).join(" ").slice(0, 300);
      const reply =
        `(Mock model — add a provider key to use a real model.) You said: "${userText.slice(0, 200)}".` +
        (found ? ` I looked this up and found: ${found}` : "");
      const words = reply.split(/(?<= )/);
      return {
        stream: streamOf([
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t1" },
          ...words.map((w): LanguageModelV4StreamPart => ({ type: "text-delta", id: "t1", delta: w })),
          { type: "text-end", id: "t1" },
          { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(inTok, Math.ceil(reply.length / 4)) },
        ]),
      };
    },
  });
}

/** Deterministic pseudo-embedding so local retrieval works without an embedding provider. */
export function mockEmbedding(text: string, dims = 1536): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const word of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    let h = 2166136261;
    for (let i = 0; i < word.length; i++) h = Math.imul(h ^ word.charCodeAt(i), 16777619);
    v[Math.abs(h) % dims]! += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}
