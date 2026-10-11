"use client";

import Link from "next/link";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { ChevronDown, ChevronRight, ScrollText } from "lucide-react";
import { Badge, Button, EmptyState, Input, Loading, PageHeader, Select, Table } from "@/components/ui";
import { ADMIN_API, FilterBar, QueryError, qs } from "@/components/admin/shared";
import type { AuditLog, CursorPage } from "@/components/admin/types";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

const ACTOR_TYPES = ["user", "api_key", "platform_admin", "system"];

export default function AdminAuditLogPage() {
  const [action, setAction] = useState("");
  const [actorType, setActorType] = useState("");
  const [applied, setApplied] = useState({ action: "", actorType: "" });
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const logs = useInfiniteQuery({
    queryKey: ["admin", "audit-logs", applied],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => api<CursorPage<AuditLog>>(`${ADMIN_API}/audit-logs${qs({ ...applied, cursor: pageParam, limit: 100 })}`),
    getNextPageParam: (last) => last.nextCursor,
  });
  const rows = logs.data?.pages.flatMap((p) => p.data) ?? [];

  const toggle = (id: string) =>
    setExpanded((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div>
      <PageHeader title="Audit log" description="Every recorded change across the platform, including actions taken here by staff." />

      <FilterBar onSubmit={() => setApplied({ action: action.trim(), actorType })}>
        <Input className="sm:w-64" placeholder="Action contains… e.g. admin." value={action} onChange={(e) => setAction(e.target.value)} aria-label="Action" />
        <Select className="sm:w-48" aria-label="Actor type" value={actorType} onChange={(e) => setActorType(e.target.value)}>
          <option value="">Any actor</option>
          {ACTOR_TYPES.map((t) => (
            <option key={t} value={t}>
              {t.replace(/_/g, " ")}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="secondary">
          Apply
        </Button>
      </FilterBar>

      {logs.error ? (
        <QueryError error={logs.error} />
      ) : logs.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState icon={ScrollText} title="No audit entries match" />
      ) : (
        <>
          <Table>
            <thead>
              <tr>
                <th className="w-8">
                  <span className="sr-only">Details</span>
                </th>
                <th>Time</th>
                <th>Action</th>
                <th>Actor</th>
                <th>Organization</th>
                <th>Target</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((l) => {
                const open = expanded.has(l.id);
                return (
                  <Fragment key={l.id}>
                    <tr>
                      <td>
                        <button
                          type="button"
                          onClick={() => toggle(l.id)}
                          aria-expanded={open}
                          aria-label={open ? "Hide details" : "Show details"}
                          className="rounded p-0.5 text-[var(--muted)] hover:bg-slate-100 hover:text-[var(--foreground)] dark:hover:bg-slate-800"
                        >
                          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                        </button>
                      </td>
                      <td className="whitespace-nowrap">{formatDateTime(l.createdAt)}</td>
                      <td className="font-mono text-xs">{l.action}</td>
                      <td>
                        <Badge tone={l.actorType === "platform_admin" ? "amber" : "neutral"}>{l.actorType.replace(/_/g, " ")}</Badge>
                        <p className="mt-0.5 text-xs text-[var(--muted)]">{l.actorEmail ?? l.actorId ?? "—"}</p>
                      </td>
                      <td>
                        {l.orgId ? (
                          <Link href={`/admin/organizations/${l.orgId}`} className="hover:underline">
                            {l.orgName ?? l.orgId}
                          </Link>
                        ) : (
                          <span className="text-[var(--muted)]">Platform</span>
                        )}
                      </td>
                      <td className="text-xs">
                        {l.targetType ?? "—"}
                        {l.targetId && <p className="font-mono break-all text-[var(--muted)]">{l.targetId}</p>}
                      </td>
                    </tr>
                    {open && (
                      <tr>
                        <td />
                        <td colSpan={5}>
                          <pre className="max-h-96 overflow-auto rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-xs leading-relaxed whitespace-pre-wrap break-all">
                            {l.diff === null || l.diff === undefined ? "No diff recorded." : JSON.stringify(l.diff, null, 2)}
                          </pre>
                          <p className="mt-1 text-xs text-[var(--muted)]">
                            IP {l.ip ?? "—"} · {l.userAgent ?? "unknown agent"}
                          </p>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </Table>
          {logs.hasNextPage && (
            <div className="mt-4 flex justify-center">
              <Button variant="secondary" disabled={logs.isFetchingNextPage} onClick={() => logs.fetchNextPage()}>
                {logs.isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
