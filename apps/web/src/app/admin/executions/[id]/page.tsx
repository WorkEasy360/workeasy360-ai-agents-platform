"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Bot, Search, ShieldCheck, Wrench } from "lucide-react";
import { Badge, Card, Loading, Notice, PageHeader, StatusBadge } from "@/components/ui";
import { ADMIN_API, JsonBlock, QueryError, StatTile } from "@/components/admin/shared";
import type { ExecutionDetail, ExecutionStep } from "@/components/admin/types";
import { api } from "@/lib/api";
import { formatDateTime, formatMs, formatNumber, formatUsd } from "@/lib/format";

const stepIcon: Record<string, typeof Bot> = { llm: Bot, tool: Wrench, retrieval: Search, guardrail: ShieldCheck };

export default function AdminExecutionDetailPage() {
  const { id } = useParams<{ id: string }>();
  // Each fetch writes an audit entry, so don't refetch on focus.
  const exec = useQuery({
    queryKey: ["admin", "execution", id],
    queryFn: () => api<ExecutionDetail>(`${ADMIN_API}/executions/${id}`),
    refetchOnWindowFocus: false,
    staleTime: Infinity,
  });

  if (exec.error) return <QueryError error={exec.error} />;
  if (!exec.data) return <Loading />;
  const x = exec.data;

  return (
    <div className="space-y-6">
      <Link href="/admin/executions" className="inline-flex items-center gap-1 text-sm text-[var(--muted)] hover:text-[var(--foreground)]">
        <ArrowLeft className="size-4" /> Executions
      </Link>

      <PageHeader
        title="Execution trace"
        description={
          <span className="flex flex-wrap items-center gap-2">
            <StatusBadge status={x.status} />
            <span>{formatDateTime(x.startedAt)}</span>
            <span>via {x.source.replace(/_/g, " ")}</span>
            <Link href={`/admin/organizations/${x.orgId}`} className="underline">
              View organization
            </Link>
          </span>
        }
      />

      <Notice>Trace content is customer data. Your view of this trace has been recorded in the audit log.</Notice>

      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <StatTile label="Cost" value={formatUsd(x.costUsd)} />
        <StatTile label="Latency" value={formatMs(x.latencyMs)} />
        <StatTile label="Tokens in / out" value={`${formatNumber(x.inputTokens)} / ${formatNumber(x.outputTokens)}`} />
        <StatTile label="Steps" value={formatNumber(x.stepCount)} />
      </div>

      {(x.errorCode || x.errorMessage) && (
        <Notice tone="warning">
          <span className="font-mono">{x.errorCode}</span>
          {x.errorMessage && `: ${x.errorMessage}`}
        </Notice>
      )}

      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-4">
          <p className="text-xs font-medium text-[var(--muted)]">Input</p>
          <p className="mt-1 text-sm whitespace-pre-wrap break-words">{x.inputPreview ?? "—"}</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs font-medium text-[var(--muted)]">Output</p>
          <p className="mt-1 text-sm whitespace-pre-wrap break-words">{x.outputPreview ?? "—"}</p>
        </Card>
      </div>

      <section>
        <h2 className="mb-3 font-medium">Steps</h2>
        {x.steps.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No steps were recorded.</p>
        ) : (
          <ol className="relative space-y-3 border-l border-[var(--border)] pl-6">
            {x.steps.map((s) => (
              <StepItem key={s.id} step={s} />
            ))}
          </ol>
        )}
      </section>

      <Card className="p-4">
        <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[auto_1fr]">
          {(
            [
              ["Execution", x.id],
              ["Agent", x.agentId],
              ["Agent version", x.agentVersionId ?? "draft"],
              ["Deployment", x.deploymentId ?? "—"],
              ["Conversation", x.conversationId ?? "—"],
              ["Completed", formatDateTime(x.completedAt)],
            ] as const
          ).map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-[var(--muted)]">{k}</dt>
              <dd className="font-mono break-all">{v}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </div>
  );
}

function StepItem({ step: s }: { step: ExecutionStep }) {
  const Icon = stepIcon[s.type] ?? Bot;
  const tokens = s.inputTokens !== null || s.outputTokens !== null;
  return (
    <li className="relative">
      <span className="absolute top-3 -left-[36.5px] flex size-6 items-center justify-center rounded-full border border-[var(--border)] bg-[var(--surface)]">
        <Icon className="size-3.5 text-[var(--muted)]" aria-hidden />
      </span>
      <Card className="p-4">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-[var(--muted)] tabular-nums">#{s.seq}</span>
          <Badge>{s.type}</Badge>
          <span className="font-medium">{s.name ?? s.type}</span>
          <StatusBadge status={s.status} />
          <span className="ml-auto text-xs text-[var(--muted)] tabular-nums">
            {s.modelKey && <span className="mr-3 font-mono">{s.modelKey}</span>}
            {tokens && (
              <span className="mr-3">
                {formatNumber(s.inputTokens)} in / {formatNumber(s.outputTokens)} out
              </span>
            )}
            {formatMs(s.latencyMs)}
          </span>
        </div>
        {s.error && <p className="mt-2 rounded bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950 dark:text-red-300">{s.error}</p>}
        <div className="mt-3 space-y-2">
          <JsonBlock label="Input" value={s.input} />
          <JsonBlock label="Output" value={s.output} />
        </div>
      </Card>
    </li>
  );
}
