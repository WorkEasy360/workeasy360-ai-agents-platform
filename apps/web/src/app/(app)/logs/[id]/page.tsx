"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Bot, ChevronDown, ChevronRight, Search, Shield, Wrench } from "lucide-react";
import { Badge, Card, FormError, Loading, Notice, PageHeader, StatusBadge } from "@/components/ui";
import { errorMessage, JsonBlock, sourceLabel } from "@/components/app/misc";
import type { ExecutionDetail, ExecutionStep } from "@/components/app/types";
import { api, ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { formatDateTime, formatMs, formatNumber, formatUsd } from "@/lib/format";

const stepMeta: Record<string, { label: string; icon: typeof Bot }> = {
  llm: { label: "AI model", icon: Bot },
  tool: { label: "Tool", icon: Wrench },
  retrieval: { label: "Knowledge search", icon: Search },
  guardrail: { label: "Safety check", icon: Shield },
};

export default function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data: run, error, isLoading } = useQuery({
    queryKey: ["execution", id],
    queryFn: () => api<ExecutionDetail>(`/api/v1/executions/${id}`),
    refetchInterval: (q) => (q.state.data?.status === "running" ? 3000 : false),
  });

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link href="/logs" className="inline-flex items-center gap-1 text-sm text-[var(--muted)] hover:text-[var(--foreground)]">
        <ArrowLeft className="size-4" /> Logs
      </Link>
      {isLoading ? (
        <Loading />
      ) : error instanceof ApiError && error.status === 404 ? (
        <Notice tone="warning">This run wasn&apos;t found. It may be older than your plan&apos;s log history.</Notice>
      ) : !run ? (
        <FormError message={errorMessage(error)} />
      ) : (
        <>
          <PageHeader
            title={`Run by ${run.agentName ?? "deleted agent"}`}
            description={`${formatDateTime(run.startedAt)} · ${sourceLabel(run.source)}`}
            actions={
              run.conversationId ? (
                <Link
                  href={`/logs/conversations/${run.conversationId}`}
                  className="inline-flex h-9 items-center rounded-md border border-[var(--border)] bg-[var(--surface)] px-4 text-sm font-medium hover:bg-slate-100 dark:hover:bg-slate-800"
                >
                  View conversation
                </Link>
              ) : undefined
            }
          />

          <Card className="grid grid-cols-2 gap-4 p-4 sm:grid-cols-5">
            <Stat label="Status">
              <StatusBadge status={run.status} />
            </Stat>
            <Stat label="Tokens">
              {formatNumber(run.inputTokens + run.outputTokens)}
              <span className="block text-xs text-[var(--muted)]">
                {formatNumber(run.inputTokens)} in · {formatNumber(run.outputTokens)} out
              </span>
            </Stat>
            <Stat label="Cost">{formatUsd(run.costUsd)}</Stat>
            <Stat label="Total time">{formatMs(run.latencyMs)}</Stat>
            <Stat label="Steps">{run.steps.length}</Stat>
          </Card>

          {(run.errorMessage || run.errorCode) && (
            <FormError message={`${run.errorMessage ?? "The run failed."}${run.errorCode ? ` (${run.errorCode.replace(/_/g, " ")})` : ""}`} />
          )}

          <div className="grid gap-4 md:grid-cols-2">
            <Card className="p-4">
              <h2 className="mb-2 text-sm font-medium text-[var(--muted)]">Message received</h2>
              <p className="text-sm whitespace-pre-wrap">{run.inputPreview || "—"}</p>
            </Card>
            <Card className="p-4">
              <h2 className="mb-2 text-sm font-medium text-[var(--muted)]">Reply</h2>
              <p className="text-sm whitespace-pre-wrap">{run.outputPreview || "—"}</p>
            </Card>
          </div>

          <section>
            <h2 className="mb-3 font-medium">What happened, step by step</h2>
            {run.steps.length === 0 ? (
              <p className="text-sm text-[var(--muted)]">No steps were recorded for this run.</p>
            ) : (
              <ol className="relative space-y-3 border-l border-[var(--border)] pl-6">
                {run.steps.map((s) => (
                  <StepItem key={s.id} step={s} />
                ))}
              </ol>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-[var(--muted)]">{label}</p>
      <div className="mt-1 text-sm font-medium tabular-nums">{children}</div>
    </div>
  );
}

function StepItem({ step }: { step: ExecutionStep }) {
  const [open, setOpen] = useState(false);
  const meta = stepMeta[step.type] ?? { label: step.type, icon: Bot };
  const Icon = meta.icon;
  const tokens = (step.inputTokens ?? 0) + (step.outputTokens ?? 0);
  return (
    <li className="relative">
      <span
        className={cn(
          "absolute top-3 -left-[2.0625rem] flex size-5 items-center justify-center rounded-full border-2 border-[var(--surface)]",
          step.status === "failed" ? "bg-red-500" : "bg-brand-500",
        )}
      >
        <Icon className="size-3 text-white" aria-hidden />
      </span>
      <Card className="p-0">
        <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-3 px-4 py-3 text-left">
          {open ? <ChevronDown className="size-4 shrink-0" /> : <ChevronRight className="size-4 shrink-0" />}
          <div className="min-w-0 flex-1">
            <p className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-[var(--muted)]">{step.seq}.</span>
              <span className="font-medium">{meta.label}</span>
              {step.name && <span className="truncate font-mono text-xs">{step.name}</span>}
              {step.status !== "succeeded" && <StatusBadge status={step.status} />}
            </p>
            {step.error && <p className="mt-1 text-xs text-red-600 dark:text-red-400">{step.error}</p>}
          </div>
          <div className="hidden shrink-0 gap-2 text-xs text-[var(--muted)] sm:flex">
            {tokens > 0 && <Badge>{formatNumber(tokens)} tokens</Badge>}
            <span className="tabular-nums">{formatMs(step.latencyMs)}</span>
          </div>
        </button>
        {open && (
          <div className="space-y-3 border-t border-[var(--border)] px-4 py-3">
            <p className="text-xs text-[var(--muted)] sm:hidden">
              {tokens > 0 && `${formatNumber(tokens)} tokens · `}
              {formatMs(step.latencyMs)}
            </p>
            {step.modelKey && <p className="text-xs text-[var(--muted)]">Model: {step.modelKey}</p>}
            <div>
              <h3 className="mb-1 text-xs font-medium tracking-wide text-[var(--muted)] uppercase">Input</h3>
              <JsonBlock value={step.input} />
            </div>
            <div>
              <h3 className="mb-1 text-xs font-medium tracking-wide text-[var(--muted)] uppercase">Output</h3>
              <JsonBlock value={step.output} />
            </div>
          </div>
        )}
      </Card>
    </li>
  );
}
