import { z } from "zod";
import { sendMail } from "../../lib/mailer";
import { redis } from "../../lib/queue";
import type { RuntimeTool, ToolProviderDefinition } from "./types";

/**
 * "Send email" tool: the agent can email a fixed list of recipients configured by the
 * customer (e.g. the sales inbox when a lead qualifies). The agent can never choose
 * recipients itself, so it can't be turned into a spam or phishing relay.
 */

export const emailConfigSchema = z.object({
  recipients: z.array(z.email()).min(1).max(5),
  subjectPrefix: z.string().max(60).default(""),
});
export type EmailToolConfig = z.infer<typeof emailConfigSchema>;

export const sendEmailDefinition: ToolProviderDefinition = {
  key: "send_email",
  displayName: "Send email",
  description: "Email your team, for example a lead summary or a callback request. Recipients are fixed by you.",
  configSchema: z.toJSONSchema(emailConfigSchema) as Record<string, unknown>,
  supportsCredential: false,
};

export const EMAIL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    subject: { type: "string", description: "Short subject line", maxLength: 150 },
    body: { type: "string", description: "Plain-text email body with all relevant details", maxLength: 5000 },
  },
  required: ["subject", "body"],
  additionalProperties: false,
};

const HOURLY_LIMIT_PER_ORG = Number(process.env.EMAIL_TOOL_HOURLY_LIMIT ?? 50);

export function buildEmailTool(row: { name: string; description: string; config: EmailToolConfig; requiresApproval: boolean }): RuntimeTool {
  return {
    name: row.name,
    description: row.description,
    inputSchema: EMAIL_INPUT_SCHEMA,
    sideEffect: "write",
    requiresApproval: row.requiresApproval,
    async execute(input, ctx) {
      const key = `email-tool:${ctx.orgId}:${Math.floor(Date.now() / 3_600_000)}`;
      const count = await redis().incr(key);
      if (count === 1) await redis().expire(key, 3700);
      if (count > HOURLY_LIMIT_PER_ORG) {
        return { forModel: { sent: false, error: "Email limit reached for this hour. Tell the user the team will follow up." } };
      }
      const subject = `${row.config.subjectPrefix ? `${row.config.subjectPrefix} ` : ""}${String(input.subject)}`.slice(0, 200);
      const body = `${String(input.body)}\n\n—\nSent by an AI agent on WorkEasy360 Agents (run ${ctx.executionId}).`;
      for (const to of row.config.recipients) await sendMail({ to, subject, text: body });
      return { forModel: { sent: true, recipients: row.config.recipients.length }, forTrace: { to: row.config.recipients, subject } };
    },
  };
}
