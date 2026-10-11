import { createHash } from "node:crypto";
import { z } from "zod";
import type { AgentConfig } from "@we360/db/schema";

/** Validation for agent configuration. Drafts may be incomplete; publishing requires `publishableConfig`. */
export const agentConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  identity: z
    .object({
      role: z.string().max(200).optional(),
      tone: z.string().max(200).optional(),
      avatarUrl: z.url().max(2000).optional(),
    })
    .default({}),
  instructions: z.string().max(20_000).default(""),
  model: z
    .object({
      modelId: z.string().default(""),
      temperature: z.number().min(0).max(1).optional(),
      maxOutputTokens: z.number().int().min(64).max(16_000).optional(),
      fallbackModelId: z.string().optional(),
    })
    .default({ modelId: "" }),
  knowledge: z
    .object({
      knowledgeBaseIds: z.array(z.uuid()).max(10).default([]),
      mode: z.enum(["auto", "always"]).default("auto"),
      topK: z.number().int().min(1).max(12).default(5),
    })
    .default({ knowledgeBaseIds: [], mode: "auto", topK: 5 }),
  tools: z
    .array(
      z.object({
        toolId: z.uuid(),
        requiresApproval: z.boolean().optional(),
        descriptionOverride: z.string().max(1000).optional(),
      }),
    )
    .max(20)
    .default([]),
  memory: z.object({ maxHistoryMessages: z.number().int().min(0).max(50).default(20) }).default({ maxHistoryMessages: 20 }),
  limits: z
    .object({
      maxSteps: z.number().int().min(1).max(15).default(6),
      timeoutMs: z.number().int().min(5_000).max(120_000).default(60_000),
    })
    .default({ maxSteps: 6, timeoutMs: 60_000 }),
  messages: z
    .object({
      welcome: z.string().max(1000).optional(),
      fallback: z.string().max(1000).optional(),
    })
    .default({}),
  variables: z
    .record(z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/), z.string().max(2000))
    .refine((v) => Object.keys(v).length <= 30, "At most 30 variables")
    .optional(),
});

export function parseAgentConfig(input: unknown): AgentConfig {
  return agentConfigSchema.parse(input) as AgentConfig;
}

/** Problems that block publishing, in plain language. */
export function publishProblems(config: AgentConfig): string[] {
  const problems: string[] = [];
  if (!config.instructions.trim()) problems.push("Add instructions so the agent knows what to do.");
  if (!config.model.modelId) problems.push("Choose a model.");
  return problems;
}

export interface AgentTemplate {
  key: string;
  name: string;
  description: string;
  config: Partial<AgentConfig>;
}

export const agentTemplates: AgentTemplate[] = [
  {
    key: "customer_support",
    name: "Customer Support FAQ",
    description: "Answers customer questions from your documents and hands off politely when it doesn't know.",
    config: {
      identity: { role: "Customer support assistant", tone: "Friendly, clear and concise" },
      instructions: [
        "You help customers of {{company_name}} with questions about products, orders and policies.",
        "Always search the knowledge base before answering questions about the business.",
        "Answer only from the information you find. If you can't find the answer, say so and suggest contacting {{support_email}}.",
        "Keep answers short. Use bullet points for steps.",
      ].join("\n"),
      knowledge: { knowledgeBaseIds: [], mode: "auto", topK: 5 },
      messages: { welcome: "Hi! How can I help you today?" },
      variables: { company_name: "our company", support_email: "support@example.com" },
    },
  },
  {
    key: "lead_qualifier",
    name: "Lead Qualifier",
    description: "Chats with website visitors, learns what they need and collects contact details.",
    config: {
      identity: { role: "Sales development representative", tone: "Warm, professional, curious" },
      instructions: [
        "You talk with visitors interested in {{company_name}}.",
        "Find out: what they need, company size, timeline and budget range. Ask one question at a time.",
        "When the visitor is a good fit, ask for their name, work email and phone number so the team can follow up.",
        "Never invent prices or commitments. If asked about pricing details, offer a call with the team.",
      ].join("\n"),
      messages: { welcome: "Hi there! What brings you here today?" },
      variables: { company_name: "our company" },
    },
  },
  {
    key: "internal_helpdesk",
    name: "Internal Helpdesk",
    description: "Answers employee questions about HR policies, IT and internal processes.",
    config: {
      identity: { role: "Internal HR and IT helpdesk assistant", tone: "Helpful and precise" },
      instructions: [
        "You help employees of {{company_name}} with HR, IT and process questions.",
        "Search the knowledge base for every policy question and cite the document you used.",
        "If a request needs a human (leave approval, hardware issues, access changes), explain how to raise it.",
      ].join("\n"),
      knowledge: { knowledgeBaseIds: [], mode: "always", topK: 5 },
      messages: { welcome: "Hi! Ask me about leave, IT, policies or processes." },
      variables: { company_name: "our company" },
    },
  },
  {
    key: "appointment_booker",
    name: "Appointment Booker",
    description: "Collects appointment requests (service, preferred time, contact details) and sends them to your team.",
    config: {
      identity: { role: "Appointment assistant", tone: "Warm, efficient and polite" },
      instructions: [
        "You help people book appointments with {{company_name}}.",
        "Collect, one question at a time: the service they need, preferred date and time, name, phone number and email.",
        "Business hours: {{business_hours}}. Don't offer times outside them.",
        "When you have all details, read them back for confirmation. Once confirmed, use the email tool (if available) to send the request to the team.",
        "Tell the person the team will confirm the slot. Never promise a confirmed booking yourself.",
      ].join("\n"),
      messages: { welcome: "Hello! I can help you book an appointment. What service are you looking for?" },
      variables: { company_name: "our clinic", business_hours: "Monday to Saturday, 10am to 6pm" },
    },
  },
  {
    key: "product_expert",
    name: "Product Expert",
    description: "Answers detailed product questions from your catalogue and guides customers to the right product.",
    config: {
      identity: { role: "Product specialist", tone: "Knowledgeable, helpful, never pushy" },
      instructions: [
        "You help customers of {{company_name}} understand and choose products.",
        "Always search the knowledge base for product details, specifications and prices. Quote only what you find.",
        "Ask about the customer's needs and budget before recommending. Recommend at most three options and explain the trade-offs.",
        "If a product or detail isn't in the knowledge base, say you don't have that information.",
      ].join("\n"),
      knowledge: { knowledgeBaseIds: [], mode: "auto", topK: 6 },
      messages: { welcome: "Hi! Looking for something specific, or want help choosing?" },
      variables: { company_name: "our store" },
    },
  },
  {
    key: "bilingual_support",
    name: "Hindi + English Support",
    description: "Customer support that replies in the customer's language: Hindi, English or Hinglish.",
    config: {
      identity: { role: "Customer support assistant", tone: "Friendly and respectful" },
      instructions: [
        "You help customers of {{company_name}}.",
        "Reply in the same language and script the customer uses: Hindi (Devanagari), English, or Hinglish (Hindi in Latin script).",
        "Search the knowledge base before answering questions about products, orders or policies, and answer only from what you find.",
        "If you can't help, share the support contact: {{support_contact}}.",
      ].join("\n"),
      knowledge: { knowledgeBaseIds: [], mode: "auto", topK: 5 },
      messages: { welcome: "Namaste! How can I help you today? / नमस्ते! मैं आपकी कैसे मदद कर सकता हूँ?" },
      variables: { company_name: "our company", support_contact: "support@example.com" },
    },
  },
];

export function templateConfig(key: string | undefined, defaultModelId: string): { config: AgentConfig; template?: AgentTemplate } {
  const template = agentTemplates.find((t) => t.key === key);
  const config = parseAgentConfig({ ...template?.config, model: { modelId: defaultModelId } });
  return { config, template };
}


/** Key-sorted JSON: jsonb doesn't preserve key order, so plain JSON.stringify isn't stable. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Stable hash of a config, used to detect unpublished changes. */
export const hashConfig = (config: unknown) => createHash("sha256").update(canonicalJson(config)).digest("hex");
