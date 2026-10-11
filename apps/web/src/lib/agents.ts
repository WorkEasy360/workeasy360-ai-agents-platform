"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export interface AgentConfig {
  schemaVersion: 1;
  identity: { role?: string; tone?: string; avatarUrl?: string };
  instructions: string;
  model: { modelId: string; temperature?: number; maxOutputTokens?: number };
  knowledge: { knowledgeBaseIds: string[]; mode: "auto" | "always"; topK: number };
  tools: Array<{ toolId: string; requiresApproval?: boolean; descriptionOverride?: string }>;
  memory: { maxHistoryMessages: number };
  limits: { maxSteps: number; timeoutMs: number };
  messages: { welcome?: string; fallback?: string };
  variables?: Record<string, string>;
}

export interface Agent {
  id: string;
  name: string;
  description: string | null;
  avatarUrl: string | null;
  status: "active" | "disabled";
  disabledByAdminAt: string | null;
  draftConfig: AgentConfig;
  draftRevision: number;
  publishedVersionId: string | null;
  publishedVersion: { id: string; versionNo: number; publishedAt: string } | null;
  hasUnpublishedChanges: boolean;
  updatedAt: string;
}

export interface AgentListItem {
  id: string;
  name: string;
  description: string | null;
  status: string;
  disabledByAdmin: boolean;
  modelName: string | null;
  publishedVersionNo: number | null;
  updatedAt: string;
  runs30d: number;
  successRate30d: number | null;
  deployments: number;
}

export interface ModelOption {
  id: string;
  provider: string;
  displayName: string;
  tier: "fast" | "balanced" | "premium";
  supportsTemperature: boolean;
  isDefault: boolean;
  allowedOnPlan: boolean;
  /** The org has a key (its own or the platform's) for this model's provider. */
  hasKey: boolean;
}

export interface Deployment {
  id: string;
  channel: "hosted_page" | "web_widget" | "api";
  versionPolicy: "latest" | "pinned";
  pinnedVersionId: string | null;
  publicKey: string | null;
  status: "active" | "paused" | "disabled_by_admin";
  config: { title?: string; allowedOrigins?: string[]; privacyPolicyUrl?: string; theme?: { primaryColor?: string; position?: "right" | "left" } };
  createdAt: string;
}

export interface AgentVersion {
  id: string;
  versionNo: number;
  changeNote: string | null;
  publishedAt: string;
}

export const useAgent = (id: string) => useQuery({ queryKey: ["agent", id], queryFn: () => api<Agent>(`/api/v1/agents/${id}`) });

export const useModels = () =>
  useQuery({ queryKey: ["models"], queryFn: () => api<{ data: ModelOption[] }>("/api/v1/models"), staleTime: 5 * 60_000 });

export const useKnowledgeBases = () =>
  useQuery({
    queryKey: ["knowledge-bases"],
    queryFn: () => api<{ data: Array<{ id: string; name: string; documentCount: number; readyCount: number }> }>("/api/v1/knowledge-bases"),
  });

export const useToolList = () =>
  useQuery({
    queryKey: ["tools"],
    queryFn: () =>
      api<{ data: Array<{ id: string; providerKey: string; name: string; description: string; config: { method?: string; url?: string } }> }>("/api/v1/tools"),
  });

export const useVersions = (agentId: string) =>
  useQuery({ queryKey: ["agent-versions", agentId], queryFn: () => api<{ data: AgentVersion[] }>(`/api/v1/agents/${agentId}/versions`) });

export const useDeployments = (agentId: string) =>
  useQuery({ queryKey: ["deployments", agentId], queryFn: () => api<{ data: Deployment[] }>(`/api/v1/agents/${agentId}/deployments`) });

/** Events streamed by POST /agents/:id/test and the public message endpoints. */
export type RunEvent =
  | { type: "run.started"; executionId: string; conversationId: string }
  | { type: "text.delta"; text: string }
  | { type: "tool.call"; id: string; name: string; input: unknown }
  | { type: "tool.result"; id: string; name: string; output: unknown; trace?: unknown; error?: string; latencyMs: number }
  | { type: "retrieval"; query: string; chunks: Array<{ documentTitle: string; content: string; score: number }> }
  | { type: "llm.step"; seq: number; inputTokens: number; outputTokens: number; latencyMs: number; costUsd: number }
  | {
      type: "run.completed";
      executionId: string;
      text: string;
      citations: Array<{ title: string; documentId: string }>;
      usage?: { inputTokens: number; outputTokens: number; costUsd: number; latencyMs: number; steps: number };
      limited?: boolean;
    }
  | { type: "run.failed"; executionId?: string; code: string; message: string };
