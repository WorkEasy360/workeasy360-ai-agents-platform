"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useState } from "react";
import { Card, Loading, Select, StatusBadge, Table } from "@/components/ui";
import { DailyBars } from "@/components/app/daily-bars";
import { api } from "@/lib/api";
import { formatMs, formatNumber, formatPercent, formatUsd, timeAgo } from "@/lib/format";

interface Analytics {
  days: number;
  runs: number;
  succeeded: number;
  failed: number;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
  conversations: number;
  daily: Array<{ day: string; runs: number; failed: number; costUsd: number }>;
}

/** Last n days (oldest first) as YYYY-MM-DD in UTC, matching the API day buckets. */
function lastDays(n: number): string[] {
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  return Array.from({ length: n }, (_, i) => new Date(today - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10));
}

interface ExecutionRow {
  id: string;
  source: string;
  status: string;
  inputPreview: string | null;
  costUsd: string;
  latencyMs: number | null;
  startedAt: string;
}

const SOURCE_LABEL: Record<string, string> = { hosted_page: "Chat page", web_widget: "Widget", api: "API", playground: "Test" };

export default function MonitorPage() {
  const { id } = useParams<{ id: string }>();
  const [days, setDays] = useState(30);
  const { data: a, isLoading } = useQuery({ queryKey: ["agent-analytics", id, days], queryFn: () => api<Analytics>(`/api/v1/agents/${id}/analytics?days=${days}`) });
  const { data: runs } = useQuery({ queryKey: ["agent-runs", id], queryFn: () => api<{ data: ExecutionRow[] }>(`/api/v1/executions?agentId=${id}&limit=20`) });

  const tiles: Array<[string, string]> = a
    ? [
        ["Messages", formatNumber(a.runs)],
        ["Conversations", formatNumber(a.conversations)],
        ["Success rate", formatPercent(a.runs ? a.succeeded / a.runs : null)],
        ["Failed", formatNumber(a.failed)],
        ["Typical response time", formatMs(a.p50LatencyMs)],
        ["Slowest 5%", formatMs(a.p95LatencyMs)],
        ["Tokens", formatNumber(a.inputTokens + a.outputTokens)],
        ["AI cost", formatUsd(a.costUsd)],
      ]
    : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-[var(--muted)]">Real conversations only (tests in the playground aren&apos;t counted).</p>
        <Select aria-label="Period" value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-36">
          <option value={7}>Last 7 days</option>
          <option value={30}>Last 30 days</option>
          <option value={90}>Last 90 days</option>
        </Select>
      </div>
      {isLoading ? (
        <Loading />
      ) : (
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          {tiles.map(([label, value]) => (
            <Card key={label} className="p-4">
              <p className="text-xs text-[var(--muted)]">{label}</p>
              <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
            </Card>
          ))}
        </div>
      )}
      {a && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <h2 className="mb-3 text-sm font-medium">Messages per day</h2>
            <DailyBars
              days={lastDays(days)}
              format={(n) => formatNumber(n)}
              series={[
                { label: "Answered", className: "bg-brand-500", values: lastDays(days).map((d) => { const r = a.daily.find((x) => x.day === d); return r ? r.runs - r.failed : 0; }) },
                { label: "Failed", className: "bg-red-400", values: lastDays(days).map((d) => a.daily.find((x) => x.day === d)?.failed ?? 0) },
              ]}
            />
          </Card>
          <Card>
            <h2 className="mb-3 text-sm font-medium">AI cost per day</h2>
            <DailyBars
              days={lastDays(days)}
              format={(n) => formatUsd(n)}
              series={[{ label: "Cost", className: "bg-brand-500", values: lastDays(days).map((d) => a.daily.find((x) => x.day === d)?.costUsd ?? 0) }]}
            />
          </Card>
        </div>
      )}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-medium">Recent activity</h2>
          <Link href={`/logs?agentId=${id}`} className="text-sm text-brand-600 hover:underline">
            All logs
          </Link>
        </div>
        <Table>
          <thead>
            <tr>
              <th>Message</th>
              <th>Channel</th>
              <th>Status</th>
              <th className="text-right">Time</th>
              <th className="text-right">Cost</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {(runs?.data ?? []).map((r) => (
              <tr key={r.id} className="hover:bg-slate-50 dark:hover:bg-slate-900">
                <td className="max-w-xs">
                  <Link href={`/logs/${r.id}`} className="line-clamp-1 hover:underline">
                    {r.inputPreview ?? "—"}
                  </Link>
                </td>
                <td>{SOURCE_LABEL[r.source] ?? r.source}</td>
                <td>
                  <StatusBadge status={r.status} />
                </td>
                <td className="text-right tabular-nums">{formatMs(r.latencyMs)}</td>
                <td className="text-right tabular-nums">{formatUsd(r.costUsd)}</td>
                <td className="text-[var(--muted)]">{timeAgo(r.startedAt)}</td>
              </tr>
            ))}
            {runs?.data.length === 0 && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-[var(--muted)]">
                  No activity yet.
                </td>
              </tr>
            )}
          </tbody>
        </Table>
      </div>
    </div>
  );
}
