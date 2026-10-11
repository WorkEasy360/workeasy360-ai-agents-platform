"use client";

import { useState } from "react";
import { AlertTriangle, BookOpen, Brain, ChevronRight, Wrench } from "lucide-react";
import type { RunEvent } from "@/lib/agents";
import { formatMs, formatUsd } from "@/lib/format";
import { cn } from "@/lib/cn";

/** Step-by-step view of one run, shown under each answer in the playground. */
export function TracePanel({ events }: { events: RunEvent[] }) {
  const [open, setOpen] = useState(false);
  const done = events.find((e) => e.type === "run.completed");
  const failed = events.find((e) => e.type === "run.failed");
  const steps = events.filter((e) => e.type !== "run.completed" && e.type !== "run.failed" && e.type !== "tool.call");
  if (!done && !failed && steps.length === 0) return null;

  return (
    <div className="mt-1.5 text-xs">
      <button onClick={() => setOpen(!open)} className="inline-flex items-center gap-1 text-[var(--muted)] hover:text-[var(--foreground)]" aria-expanded={open}>
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        {done?.type === "run.completed" && done.usage
          ? `${done.usage.steps} steps · ${formatMs(done.usage.latencyMs)} · ${(done.usage.inputTokens + done.usage.outputTokens).toLocaleString()} tokens · ${formatUsd(done.usage.costUsd)}`
          : failed
            ? "Run failed — show details"
            : "Show steps"}
        {done?.type === "run.completed" && done.limited && <span className="ml-1 text-amber-600">· stopped at step limit</span>}
      </button>
      {open && (
        <ol className="mt-2 space-y-1.5 border-l border-[var(--border)] pl-3">
          {steps.map((e, i) => (
            <TraceStep key={i} event={e} />
          ))}
          {failed?.type === "run.failed" && (
            <li className="flex gap-2 text-red-600 dark:text-red-400">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span>
                {failed.message} <code className="opacity-70">({failed.code})</code>
              </span>
            </li>
          )}
        </ol>
      )}
    </div>
  );
}

function TraceStep({ event: e }: { event: RunEvent }) {
  const [expanded, setExpanded] = useState(false);
  if (e.type === "llm.step") {
    return (
      <li className="flex gap-2">
        <Brain className="mt-0.5 size-3.5 shrink-0 text-brand-600" />
        <span>
          Model call {e.seq} · {e.inputTokens + e.outputTokens} tokens · {formatMs(e.latencyMs)} · {formatUsd(e.costUsd)}
        </span>
      </li>
    );
  }
  if (e.type === "retrieval") {
    return (
      <li>
        <button className="flex gap-2 text-left" onClick={() => setExpanded(!expanded)}>
          <BookOpen className="mt-0.5 size-3.5 shrink-0 text-emerald-600" />
          <span>Knowledge search for “{e.query}” · {e.chunks.length} results</span>
        </button>
        {expanded && <Chunks chunks={e.chunks} />}
      </li>
    );
  }
  if (e.type === "tool.result") {
    const isKnowledge = e.name === "knowledge_search";
    return (
      <li>
        <button className="flex gap-2 text-left" onClick={() => setExpanded(!expanded)}>
          {isKnowledge ? <BookOpen className="mt-0.5 size-3.5 shrink-0 text-emerald-600" /> : <Wrench className="mt-0.5 size-3.5 shrink-0 text-amber-600" />}
          <span className={cn(e.error && "text-red-600 dark:text-red-400")}>
            {isKnowledge ? "Knowledge search" : `Tool: ${e.name}`} · {formatMs(e.latencyMs)}
            {e.error ? ` · ${e.error}` : ""}
          </span>
        </button>
        {expanded &&
          (isKnowledge && Array.isArray(e.trace) ? (
            <Chunks chunks={e.trace as Array<{ documentTitle: string; content: string; score: number }>} />
          ) : (
            <pre className="mt-1 max-h-60 overflow-auto rounded bg-slate-50 p-2 text-[11px] dark:bg-slate-900">{JSON.stringify({ output: e.output, trace: e.trace }, null, 2)}</pre>
          ))}
      </li>
    );
  }
  return null;
}

function Chunks({ chunks }: { chunks: Array<{ documentTitle: string; content: string; score: number }> }) {
  return (
    <ul className="mt-1 space-y-1">
      {chunks.map((c, i) => (
        <li key={i} className="rounded bg-slate-50 p-2 dark:bg-slate-900">
          <p className="font-medium">
            {c.documentTitle} <span className="font-normal text-[var(--muted)]">· relevance {c.score.toFixed(3)}</span>
          </p>
          <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-[var(--muted)]">{c.content}</p>
        </li>
      ))}
    </ul>
  );
}
