"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { Button, EmptyState, FormError, Loading, Select, StatusBadge, Table } from "@/components/ui";
import { errorMessage, sourceLabel } from "@/components/app/misc";
import type { ExecutionRow, Page } from "@/components/app/types";
import { api } from "@/lib/api";
import { formatDateTime, formatMs, formatNumber, formatUsd } from "@/lib/format";
import { AgentFilter, qs } from "./shared";

export function RunsTab() {
  const router = useRouter();
  const [agentId, setAgentId] = useState("");
  const [status, setStatus] = useState("");
  const [source, setSource] = useState("");

  const q = useInfiniteQuery({
    queryKey: ["executions", { agentId, status, source }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      api<Page<ExecutionRow>>(`/api/v1/executions${qs({ agentId, status, source, cursor: pageParam, limit: "50" })}`),
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  const filtered = Boolean(agentId || status || source);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-2 sm:flex-row">
        <AgentFilter value={agentId} onChange={setAgentId} />
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="sm:w-40">
          <option value="">Any status</option>
          <option value="succeeded">Succeeded</option>
          <option value="failed">Failed</option>
          <option value="limited">Limited</option>
          <option value="running">Running</option>
        </Select>
        <Select aria-label="Source" value={source} onChange={(e) => setSource(e.target.value)} className="sm:w-44">
          <option value="">Any source</option>
          {["playground", "hosted_page", "web_widget", "api"].map((s) => (
            <option key={s} value={s}>
              {sourceLabel(s)}
            </option>
          ))}
        </Select>
      </div>

      <FormError message={errorMessage(q.error)} />
      {q.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title={filtered ? "No runs match these filters" : "No runs yet"}
          description={filtered ? "Try a different agent, status or source." : "Each time an agent answers a message, it shows up here. Try chatting with an agent to see one."}
        />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <th>When</th>
                <th>Agent</th>
                <th>Message</th>
                <th>Status</th>
                <th>Source</th>
                <th className="text-right">Tokens</th>
                <th className="text-right">Cost</th>
                <th className="text-right">Time</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.id}
                  onClick={() => router.push(`/logs/${r.id}`)}
                  className="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/50"
                >
                  <td className="whitespace-nowrap">
                    <Link href={`/logs/${r.id}`} onClick={(e) => e.stopPropagation()} className="text-brand-700 hover:underline dark:text-brand-100">
                      {formatDateTime(r.startedAt)}
                    </Link>
                  </td>
                  <td className="whitespace-nowrap">{r.agentName ?? "Deleted agent"}</td>
                  <td className="max-w-xs min-w-48">
                    <p className="truncate">{r.inputPreview || "—"}</p>
                    {r.outputPreview && <p className="truncate text-xs text-[var(--muted)]">{r.outputPreview}</p>}
                  </td>
                  <td className="whitespace-nowrap">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="whitespace-nowrap">{sourceLabel(r.source)}</td>
                  <td className="text-right whitespace-nowrap tabular-nums">{formatNumber(r.inputTokens + r.outputTokens)}</td>
                  <td className="text-right whitespace-nowrap tabular-nums">{formatUsd(r.costUsd)}</td>
                  <td className="text-right whitespace-nowrap tabular-nums">{formatMs(r.latencyMs)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          {q.hasNextPage && (
            <div className="flex justify-center">
              <Button variant="secondary" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
                {q.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
