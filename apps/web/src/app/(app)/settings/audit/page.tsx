"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { Button, FormError, Input, Loading, Table } from "@/components/ui";
import { errorMessage, JsonBlock } from "@/components/app/misc";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/format";

interface AuditEntry {
  id: string;
  action: string;
  actorType: string;
  actorName: string | null;
  actorEmail: string | null;
  targetType: string | null;
  targetId: string | null;
  diff: unknown;
  ip: string | null;
  createdAt: string;
}

/** "agent.published" → "Agent published" */
const describe = (action: string) => {
  const s = action.replace(/^admin\./, "").replace(/[._]/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

export default function AuditLogPage() {
  const [filter, setFilter] = useState("");
  const [applied, setApplied] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const q = useInfiniteQuery({
    queryKey: ["audit-logs", applied],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: "50" });
      if (applied) params.set("action", applied);
      if (pageParam) params.set("cursor", pageParam);
      return api<{ data: AuditEntry[]; nextCursor: string | null }>(`/api/v1/organization/audit-logs?${params}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];

  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--muted)]">Who changed what in this organization: agents, publishing, credentials, members, channels and more.</p>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          setApplied(filter.trim());
        }}
      >
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by action, e.g. published" className="max-w-xs" aria-label="Filter by action" />
        <Button type="submit" variant="secondary">
          Filter
        </Button>
      </form>
      <FormError message={errorMessage(q.error)} />
      {q.isLoading ? (
        <Loading />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>When</th>
              <th>Who</th>
              <th>What</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <Fragment key={r.id}>
                <tr>
                  <td className="whitespace-nowrap text-[var(--muted)]">{formatDateTime(r.createdAt)}</td>
                  <td>
                    {r.actorName ?? (r.actorType === "api_key" ? "API key" : r.actorType === "system" ? "System" : "—")}
                    {r.actorEmail && <span className="block text-xs text-[var(--muted)]">{r.actorEmail}</span>}
                  </td>
                  <td>{describe(r.action)}</td>
                  <td className="text-right">
                    {r.diff ? (
                      <Button size="sm" variant="ghost" onClick={() => setOpen(open === r.id ? null : r.id)}>
                        {open === r.id ? "Hide" : "Details"}
                      </Button>
                    ) : null}
                  </td>
                </tr>
                {open === r.id && (
                  <tr>
                    <td colSpan={4}>
                      <JsonBlock value={r.diff} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={4} className="py-6 text-center text-[var(--muted)]">
                  Nothing recorded yet.
                </td>
              </tr>
            )}
          </tbody>
        </Table>
      )}
      {q.hasNextPage && (
        <Button variant="secondary" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
          {q.isFetchingNextPage ? "Loading…" : "Load more"}
        </Button>
      )}
    </div>
  );
}
