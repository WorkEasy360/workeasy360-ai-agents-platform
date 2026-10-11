"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Suspense, useState } from "react";
import { Workflow } from "lucide-react";
import { Button, EmptyState, Input, Loading, PageHeader, Select, StatusBadge, Table } from "@/components/ui";
import { ADMIN_API, FilterBar, QueryError, qs } from "@/components/admin/shared";
import type { CursorPage, ExecutionRow, OrgRow, Page } from "@/components/admin/types";
import { api } from "@/lib/api";
import { formatDateTime, formatMs, formatNumber, formatUsd } from "@/lib/format";

const STATUSES = ["running", "succeeded", "failed", "limited", "cancelled"];

export default function AdminExecutionsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <ExecutionsExplorer />
    </Suspense>
  );
}

interface Filters {
  orgId: string;
  agentId: string;
  status: string;
  minCostUsd: string;
}

function ExecutionsExplorer() {
  const params = useSearchParams();
  const initial: Filters = {
    orgId: params.get("orgId") ?? "",
    agentId: params.get("agentId") ?? "",
    status: params.get("status") ?? "",
    minCostUsd: "",
  };
  // Draft = what's in the form; applied = what's queried.
  const [draft, setDraft] = useState<Filters>(initial);
  const [applied, setApplied] = useState<Filters>(initial);

  const orgs = useQuery({ queryKey: ["admin", "orgs", "picker"], queryFn: () => api<Page<OrgRow>>(`${ADMIN_API}/organizations?limit=100`) });

  const execs = useInfiniteQuery({
    queryKey: ["admin", "executions", applied],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api<CursorPage<ExecutionRow>>(`${ADMIN_API}/executions${qs({ ...applied, cursor: pageParam, limit: 50 })}`),
    getNextPageParam: (last) => last.nextCursor,
  });
  const rows = execs.data?.pages.flatMap((p) => p.data) ?? [];

  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setDraft((d) => ({ ...d, [k]: e.target.value }));

  return (
    <div>
      <PageHeader title="Executions" description="Agent runs across all organizations, newest first." />

      <FilterBar onSubmit={() => setApplied({ ...draft, agentId: draft.agentId.trim(), minCostUsd: draft.minCostUsd.trim() })}>
        <Select className="sm:w-52" aria-label="Organization" value={draft.orgId} onChange={set("orgId")}>
          <option value="">All organizations</option>
          {orgs.data?.data.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </Select>
        <Input className="sm:w-72" placeholder="Agent ID" value={draft.agentId} onChange={set("agentId")} aria-label="Agent ID" />
        <Select className="sm:w-40" aria-label="Status" value={draft.status} onChange={set("status")}>
          <option value="">Any status</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Input className="sm:w-36" type="number" min={0} step="0.0001" placeholder="Min cost USD" value={draft.minCostUsd} onChange={set("minCostUsd")} aria-label="Minimum cost in USD" />
        <Button type="submit" variant="secondary">
          Apply
        </Button>
      </FilterBar>

      {execs.error ? (
        <QueryError error={execs.error} />
      ) : execs.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState icon={Workflow} title="No executions match" />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Organization</th>
                <th>Agent</th>
                <th>Source</th>
                <th>Status</th>
                <th className="text-right">Tokens in / out</th>
                <th className="text-right">Cost</th>
                <th className="text-right">Latency</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => (
                <tr key={x.id}>
                  <td className="whitespace-nowrap">
                    <Link href={`/admin/executions/${x.id}`} className="text-brand-700 hover:underline dark:text-brand-100">
                      {formatDateTime(x.startedAt)}
                    </Link>
                  </td>
                  <td>
                    <Link href={`/admin/organizations/${x.orgId}`} className="hover:underline">
                      {x.orgName ?? "—"}
                    </Link>
                  </td>
                  <td>{x.agentName ?? "—"}</td>
                  <td>{x.source.replace(/_/g, " ")}</td>
                  <td>
                    <StatusBadge status={x.status} />
                    {x.errorCode && <p className="mt-0.5 font-mono text-xs text-[var(--muted)]">{x.errorCode}</p>}
                  </td>
                  <td className="text-right whitespace-nowrap tabular-nums">
                    {formatNumber(x.inputTokens)} / {formatNumber(x.outputTokens)}
                  </td>
                  <td className="text-right tabular-nums">{formatUsd(x.costUsd)}</td>
                  <td className="text-right tabular-nums">{formatMs(x.latencyMs)}</td>
                </tr>
              ))}
            </tbody>
          </Table>
          {execs.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button variant="secondary" disabled={execs.isFetchingNextPage} onClick={() => execs.fetchNextPage()}>
                {execs.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
