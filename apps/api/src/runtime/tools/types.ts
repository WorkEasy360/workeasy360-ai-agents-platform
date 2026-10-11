/** A tool as the agent runtime sees it: schema for the model + a handler. */
export interface RuntimeTool {
  /** Model-facing function name: lowercase, digits and underscores. */
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  sideEffect: "read" | "write";
  requiresApproval: boolean;
  execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolOutput>;
}

export interface ToolContext {
  orgId: string;
  workspaceId: string;
  agentId: string;
  executionId: string;
  signal: AbortSignal;
}

export interface ToolOutput {
  /** What the model sees (truncated). */
  forModel: unknown;
  /** Extra detail for the trace (e.g. retrieved chunks). Never sent to public channels. */
  forTrace?: unknown;
}

/** Static definition of a tool type users can configure (the "catalog"). */
export interface ToolProviderDefinition {
  key: string;
  displayName: string;
  description: string;
  /** JSON Schema of the provider's static config (what the user fills in). */
  configSchema: Record<string, unknown>;
  supportsCredential: boolean;
}

export const MAX_TOOL_OUTPUT_CHARS = 8_000;

export function truncateForModel(text: string): string {
  return text.length > MAX_TOOL_OUTPUT_CHARS
    ? `${text.slice(0, MAX_TOOL_OUTPUT_CHARS)}\n…[truncated ${text.length - MAX_TOOL_OUTPUT_CHARS} characters]`
    : text;
}
