"use client";

import { useQuery } from "@tanstack/react-query";
import { Card, Loading, Notice, PageHeader, StatusBadge, Table } from "@/components/ui";
import { ADMIN_API, QueryError, StatTile } from "@/components/admin/shared";
import type { Health } from "@/components/admin/types";
import { api } from "@/lib/api";
import { formatNumber, timeAgo } from "@/lib/format";

const QUEUE_STATES = ["waiting", "active", "delayed", "failed", "completed"];

function formatUptime(sec: number): string {
  const d = Math.floor(sec / 86_400);
  const h = Math.floor((sec % 86_400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

export default function AdminHealthPage() {
  const health = useQuery({
    queryKey: ["admin", "health"],
    queryFn: () => api<Health>(`${ADMIN_API}/health`),
    refetchInterval: 15_000,
  });

  const h = health.data;
  const queueError = h && "error" in h.ingestQueue ? String(h.ingestQueue.error) : null;
  const queue = h && !queueError ? (h.ingestQueue as Record<string, number>) : null;
  const failures = h?.failuresLast24h.reduce((s, r) => s + r.n, 0) ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="System health"
        description={
          <>
            Refreshes every 15 seconds{health.dataUpdatedAt ? ` · last checked ${timeAgo(new Date(health.dataUpdatedAt))}` : ""}.
          </>
        }
      />

      {health.error && <QueryError error={health.error} />}
      {!h && !health.error && <Loading />}

      {h && (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <StatTile label="API" value={h.api === "ok" ? "OK" : h.api} hint={`Up ${formatUptime(h.uptimeSec)}`} />
            <StatTile label="Database latency" value={`${h.dbLatencyMs} ms`} tone={h.dbLatencyMs > 200 ? "danger" : undefined} />
            <StatTile label="Failed runs (24h)" value={formatNumber(failures)} tone={failures ? "danger" : undefined} />
            <StatTile label="Ingest jobs waiting" value={queue ? formatNumber(queue.waiting) : "—"} />
          </div>

          <Card>
            <h2 className="mb-3 font-medium">Ingest queue</h2>
            {queueError ? (
              <Notice tone="warning">Queue unreachable: {queueError}</Notice>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                {QUEUE_STATES.map((s) => (
                  <div key={s} className="rounded-md border border-[var(--border)] px-3 py-2">
                    <p className="text-xs text-[var(--muted)] capitalize">{s}</p>
                    <p className={`text-lg font-semibold tabular-nums ${s === "failed" && queue?.[s] ? "text-red-600 dark:text-red-400" : ""}`}>
                      {formatNumber(queue?.[s] ?? 0)}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </Card>

          <div className="grid gap-6 md:grid-cols-2">
            <section>
              <h2 className="mb-3 font-medium">Failure codes, last 24 hours</h2>
              <Table>
                <thead>
                  <tr>
                    <th>Error code</th>
                    <th className="text-right">Runs</th>
                  </tr>
                </thead>
                <tbody>
                  {h.failuresLast24h.length === 0 && (
                    <tr>
                      <td colSpan={2} className="text-[var(--muted)]">
                        No failed runs.
                      </td>
                    </tr>
                  )}
                  {h.failuresLast24h.map((f) => (
                    <tr key={f.error_code ?? "none"}>
                      <td className="font-mono text-xs">{f.error_code ?? "(no code)"}</td>
                      <td className="text-right tabular-nums">{formatNumber(f.n)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </section>

            <section>
              <h2 className="mb-3 font-medium">Documents updated, last 7 days</h2>
              <Table>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th className="text-right">Documents</th>
                  </tr>
                </thead>
                <tbody>
                  {h.documentsLast7d.length === 0 && (
                    <tr>
                      <td colSpan={2} className="text-[var(--muted)]">
                        No document activity.
                      </td>
                    </tr>
                  )}
                  {h.documentsLast7d.map((d) => (
                    <tr key={d.status}>
                      <td>
                        <StatusBadge status={d.status} />
                      </td>
                      <td className="text-right tabular-nums">{formatNumber(d.n)}</td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
