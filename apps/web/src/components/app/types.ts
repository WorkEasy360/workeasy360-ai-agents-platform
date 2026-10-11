// Response shapes for the tenant API endpoints used by these pages.

export interface KnowledgeBase {
  id: string;
  name: string;
  description: string | null;
  updatedAt: string;
  documentCount: number;
  readyCount: number;
  sizeBytes: number;
}

export type DocStatus = "queued" | "parsing" | "embedding" | "ready" | "failed";

export interface KbDocument {
  id: string;
  title: string;
  sourceType: "file" | "text" | "url";
  sourceUrl: string | null;
  mimeType: string | null;
  sizeBytes: number;
  status: DocStatus;
  error: string | null;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface Chunk {
  id: string;
  ordinal: number;
  content: string;
  metadata: { headingPath?: string[]; page?: number } | null;
  tokenCount: number | null;
}

export interface SearchHit {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  content: string;
  score: number;
  metadata: { headingPath?: string[]; page?: number } | null;
}

export interface ToolParam {
  name: string;
  type: "string" | "number" | "boolean";
  description: string;
  required: boolean;
}

export interface HttpConfig {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  headers: Record<string, string>;
  params: ToolParam[];
  timeoutMs: number;
}

export interface Tool {
  id: string;
  providerKey: string;
  name: string;
  description: string;
  /** HTTP tools use the HttpConfig fields; email tools use recipients/subjectPrefix. */
  config: HttpConfig & { recipients?: string[]; subjectPrefix?: string };
  credentialId: string | null;
  credentialName: string | null;
  updatedAt: string;
}

export interface Credential {
  id: string;
  name: string;
  authType: "bearer" | "api_key" | "basic" | "header";
  last4: string | null;
  metadata: { headerName?: string } | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface ExecutionRow {
  id: string;
  agentId: string;
  agentName: string | null;
  source: string;
  status: string;
  errorCode: string | null;
  inputPreview: string | null;
  outputPreview: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
  latencyMs: number | null;
  startedAt: string;
}

export interface ExecutionStep {
  id: string;
  seq: number;
  type: string;
  name: string | null;
  status: string;
  input: unknown;
  output: unknown;
  modelKey: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number | null;
  error: string | null;
  startedAt: string;
}

export interface ExecutionDetail extends ExecutionRow {
  conversationId: string | null;
  agentVersionId: string | null;
  errorMessage: string | null;
  stepCount: number;
  completedAt: string | null;
  steps: ExecutionStep[];
}

export interface ConversationRow {
  id: string;
  agentId: string;
  agentName: string | null;
  channel: string;
  title: string | null;
  endUserRef: string | null;
  lastMessageAt: string | null;
  createdAt: string;
}

export interface Message {
  id: string;
  role: "user" | "assistant" | "tool";
  content: { text?: string; citations?: Array<{ documentId: string; title: string }> } | null;
  executionId: string | null;
  feedback: 1 | -1 | null;
  createdAt: string;
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export interface AgentSummary {
  id: string;
  name: string;
}
