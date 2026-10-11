"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Suspense, useState } from "react";
import { Bot } from "lucide-react";
import { Button, EmptyState, Input, Loading, PageHeader, StatusBadge, Table } from "@/components/ui";
import { AgentActions } from "@/components/admin/agent-actions";
import { ADMIN_API, FilterBar, OffsetPager, QueryError, qs } from "@/components/admin/shared";
import type { AgentRow, Page } from "@/components/admin/types";
import { api } from "@/lib/api";
import { formatNumber, timeAgo } from "@/lib/format";

const LIMIT = 50;

export default function AdminAgentsPage() {
  return (
    <Suspense fallback={<Loading />}>
      <AgentsList />
    </Suspense>
  );
}

function AgentsList() {
  const orgId = useSearchParams().get("orgId") ?? "";
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);

  const agents = useQuery({
    queryKey: ["admin", "agents", { q, orgId, offset }],
    queryFn: () => api<Page<AgentRow>>(`${ADMIN_API}/agents${qs({ q, orgId, limit: LIMIT, offset })}`),
    placeholderData: (prev) => prev,
  });
  const rows = agents.data?.data ?? [];

  return (
    <div>
      <PageHeader
        title="Agents"
        description={
          orgId ? (
            <>
              Filtered to one organization. <Link href="/admin/agents" className="underline">Show all</Link>
            </>
          ) : (
            "Every agent on the platform. Disabling an agent stops all of its channels immediately."
          )
        }
      />
      <FilterBar
        onSubmit={() => {
          setQ(search.trim());
          setOffset(0);
        }}
      >
        <Input className="sm:w-72" placeholder="Search agent name" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search agents" />
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </FilterBar>

      {agents.error ? (
        <QueryError error={agents.error} />
      ) : agents.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState icon={Bot} title="No agents found" />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Organization</th>
              <th>Status</th>
              <th className="text-right">Runs (30d)</th>
              <th>Updated</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td className="font-medium">
                  <Link href={`/admin/executions?agentId=${a.id}`} className="hover:underline" title="View executions">
                    {a.name}
                  </Link>
                </td>
                <td>
                  <Link href={`/admin/organizations/${a.orgId}`} className="text-brand-700 hover:underline dark:text-brand-100">
                    {a.orgName}
                  </Link>
                </td>
                <td>
                  <StatusBadge status={a.disabledByAdminAt ? "disabled_by_admin" : a.status} />
                </td>
                <td className="text-right tabular-nums">{formatNumber(a.runs30d)}</td>
                <td className="whitespace-nowrap">{timeAgo(a.updatedAt)}</td>
                <td className="text-right">
                  <AgentActions agent={a} />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <OffsetPager offset={offset} limit={LIMIT} count={rows.length} onChange={setOffset} />
    </div>
  );
}
