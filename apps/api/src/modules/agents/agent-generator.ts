import { generateText, Output } from "ai";
import { z } from "zod";
import { AppError } from "../../lib/errors";
import { getDefaultModelForTiers } from "../models/catalog";
import { mockEnabled, resolveChatModel, usableProviders } from "../models/gateway";
import { getOrgLimits } from "../plans/plan-limits";
import { assertCanRun, recordUsage } from "../usage/usage.service";

/** "Describe your agent": turns a plain-language description into a starting configuration. */

export const draftSchema = z.object({
  name: z.string().max(80).describe("Short agent name, e.g. 'Acme Support Assistant'"),
  role: z.string().max(200).describe("One line: what the agent is"),
  tone: z.string().max(200).describe("How it should sound"),
  instructions: z
    .string()
    .max(6000)
    .describe("Clear instructions in second person: goals, what to do step by step, what never to do, when to hand off to a human"),
  welcomeMessage: z.string().max(300).describe("First message shown to people"),
  needsKnowledge: z.boolean().describe("Whether the agent should answer from uploaded company documents"),
});
export type AgentDraft = z.infer<typeof draftSchema>;

const SYSTEM = `You design AI agents for small and medium businesses. Given a description, write a practical configuration.
Instructions must be specific, use short paragraphs or bullet points, include what to do when the agent doesn't know
(admit it and offer a human handoff), never invent prices, policies or commitments, and keep answers concise.
Write in the same language as the description.`;

function mockDraft(description: string): AgentDraft {
  const summary = description.trim().replace(/\s+/g, " ").slice(0, 160);
  return {
    name: "My Assistant",
    role: `Assistant that ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`.slice(0, 200),
    tone: "Friendly, clear and concise",
    instructions: [
      `Your job: ${summary}`,
      "",
      "- Ask one clarifying question at a time when a request is unclear.",
      "- Check the knowledge base before answering questions about the business.",
      "- If you don't know the answer, say so and offer to connect the person with the team.",
      "- Never invent prices, policies or commitments.",
    ].join("\n"),
    welcomeMessage: "Hi! How can I help you today?",
    needsKnowledge: true,
  };
}

export async function generateAgentDraft(orgId: string, description: string): Promise<AgentDraft> {
  if (mockEnabled()) return mockDraft(description);

  const model = await getDefaultModelForTiers((await getOrgLimits(orgId)).modelTiers, await usableProviders(orgId));
  if (!model) throw new AppError(503, "model_unavailable", "No model is available for your plan.");
  const { languageModel, billingSource } = await resolveChatModel(orgId, model);
  await assertCanRun(orgId, { source: "playground", billingSource });

  const result = await generateText({
    model: languageModel,
    instructions: SYSTEM,
    prompt: `Description of the agent the business wants:\n\n${description}`,
    output: Output.object({ schema: draftSchema }),
    maxRetries: 2,
    abortSignal: AbortSignal.timeout(60_000),
  });
  await recordUsage({
    orgId,
    model,
    kind: "chat",
    billingSource,
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
  });
  return result.output;
}
