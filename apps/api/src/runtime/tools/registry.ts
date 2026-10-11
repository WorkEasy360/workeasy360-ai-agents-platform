import { and, inArray, isNull } from "drizzle-orm";
import { withTenant } from "@we360/db";
import { type AgentConfig, credentials, tools } from "@we360/db/schema";
import { decryptSecret } from "../../lib/crypto";
import { buildHttpTool, type HttpToolConfig, httpRequestDefinition } from "./http-request";
import { buildKnowledgeTool } from "./knowledge-search";
import { buildEmailTool, type EmailToolConfig, sendEmailDefinition } from "./send-email";
import type { RuntimeTool, ToolProviderDefinition } from "./types";

/**
 * Tool providers available to users. Adding a provider means adding a definition and a builder
 * here; the runtime itself doesn't change.
 */
export const toolCatalog: ToolProviderDefinition[] = [httpRequestDefinition, sendEmailDefinition];

/** Loads and builds the tools an agent config uses. Secrets are decrypted only here. */
export async function buildRuntimeTools(orgId: string, config: AgentConfig): Promise<RuntimeTool[]> {
  const result: RuntimeTool[] = [];

  if (config.knowledge.knowledgeBaseIds.length > 0 && config.knowledge.mode === "auto") {
    result.push(buildKnowledgeTool(config.knowledge.knowledgeBaseIds, config.knowledge.topK));
  }

  const ids = config.tools.map((t) => t.toolId);
  if (ids.length === 0) return result;

  const { rows, creds } = await withTenant(orgId, async (tx) => {
    const rows = await tx
      .select()
      .from(tools)
      .where(and(inArray(tools.id, ids), isNull(tools.deletedAt)));
    const credIds = rows.map((r) => r.credentialId).filter((x): x is string => Boolean(x));
    const creds = credIds.length
      ? await tx
          .select()
          .from(credentials)
          .where(and(inArray(credentials.id, credIds), isNull(credentials.deletedAt)))
      : [];
    return { rows, creds };
  });

  for (const binding of config.tools) {
    const row = rows.find((r) => r.id === binding.toolId);
    if (!row) continue; // Tool deleted since the version was published; skip rather than fail the run.
    if (row.providerKey === "send_email") {
      result.push(
        buildEmailTool({
          name: row.name,
          description: binding.descriptionOverride || row.description,
          config: row.config as EmailToolConfig,
          requiresApproval: binding.requiresApproval ?? false,
        }),
      );
    } else if (row.providerKey === "http_request") {
      const cfg = row.config as HttpToolConfig;
      const cred = creds.find((c) => c.id === row.credentialId);
      result.push(
        buildHttpTool({
          name: row.name,
          description: binding.descriptionOverride || row.description,
          config: cfg,
          sideEffect: cfg.method === "GET" ? "read" : "write",
          requiresApproval: binding.requiresApproval ?? false,
          auth: cred
            ? {
                authType: cred.authType,
                secret: await decryptSecret(cred),
                headerName: (cred.metadata as { headerName?: string }).headerName,
              }
            : undefined,
        }),
      );
    }
  }
  return result;
}
