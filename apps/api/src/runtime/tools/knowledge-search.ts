import { searchKnowledge } from "../../modules/knowledge/retrieval";
import type { RuntimeTool } from "./types";

export const KNOWLEDGE_TOOL_NAME = "knowledge_search";

export function buildKnowledgeTool(knowledgeBaseIds: string[], topK: number): RuntimeTool {
  return {
    name: KNOWLEDGE_TOOL_NAME,
    description:
      "Search the company's knowledge base (documents, FAQs, policies). Use it before answering questions " +
      "about the business, its products or policies. Pass a short, specific search query.",
    inputSchema: {
      type: "object",
      properties: { query: { type: "string", description: "What to search for" } },
      required: ["query"],
      additionalProperties: false,
    },
    sideEffect: "read",
    requiresApproval: false,
    async execute(input, ctx) {
      const chunks = await searchKnowledge({
        orgId: ctx.orgId,
        knowledgeBaseIds,
        query: String(input.query ?? ""),
        topK,
        agentId: ctx.agentId,
        executionId: ctx.executionId,
      });
      return {
        forModel: chunks.length
          ? chunks.map((c, i) => ({ source: i + 1, title: c.documentTitle, text: c.content }))
          : "No matching information found in the knowledge base.",
        forTrace: chunks,
      };
    },
  };
}
