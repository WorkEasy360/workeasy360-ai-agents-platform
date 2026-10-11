"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Building2 } from "lucide-react";
import { Button, EmptyState, Input, Loading, PageHeader, Select, StatusBadge, Table } from "@/components/ui";
import { ADMIN_API, FilterBar, OffsetPager, QueryError, qs } from "@/components/admin/shared";
import type { OrgRow, Page, Plan } from "@/components/admin/types";
import { api } from "@/lib/api";
import { formatDate, formatNumber, formatUsd } from "@/lib/format";

const LIMIT = 50;

export default function AdminOrganizationsPage() {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [plan, setPlan] = useState("");
  const [status, setStatus] = useState("");
  const [offset, setOffset] = useState(0);

  const plans = useQuery({ queryKey: ["admin", "plans"], queryFn: () => api<Page<Plan>>(`${ADMIN_API}/plans`) });
  const orgs = useQuery({
    queryKey: ["admin", "orgs", { q, plan, status, offset }],
    queryFn: () => api<Page<OrgRow>>(`${ADMIN_API}/organizations${qs({ q, plan, status, limit: LIMIT, offset })}`),
    placeholderData: (prev) => prev,
  });

  const rows = orgs.data?.data ?? [];

  return (
    <div>
      <PageHeader title="Organizations" description="Every tenant on the platform." />

      <FilterBar
        onSubmit={() => {
          setQ(search.trim());
          setOffset(0);
        }}
      >
        <Input className="sm:w-64" placeholder="Search name or slug" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search organizations" />
        <Select
          className="sm:w-44"
          aria-label="Plan"
          value={plan}
          onChange={(e) => {
            setPlan(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">All plans</option>
          {plans.data?.data.map((p) => (
            <option key={p.key} value={p.key}>
              {p.name}
            </option>
          ))}
        </Select>
        <Select
          className="sm:w-40"
          aria-label="Status"
          value={status}
          onChange={(e) => {
            setStatus(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">Any status</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
        </Select>
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </FilterBar>

      {orgs.error ? (
        <QueryError error={orgs.error} />
      ) : orgs.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState icon={Building2} title="No organizations found" description="Try a different search or filter." />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Plan</th>
              <th>Status</th>
              <th className="text-right">Members</th>
              <th className="text-right">Agents</th>
              <th className="text-right">Runs (30d)</th>
              <th className="text-right">Cost this month</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <tr key={o.id}>
                <td>
                  <Link href={`/admin/organizations/${o.id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-100">
                    {o.name}
                  </Link>
                  <p className="text-xs text-[var(--muted)]">{o.slug}</p>
                </td>
                <td className="capitalize">{o.planKey}</td>
                <td>
                  <StatusBadge status={o.status} />
                </td>
                <td className="text-right tabular-nums">{formatNumber(o.members)}</td>
                <td className="text-right tabular-nums">{formatNumber(o.agents)}</td>
                <td className="text-right tabular-nums">{formatNumber(o.runs30d)}</td>
                <td className="text-right tabular-nums">{formatUsd(o.costMonthUsd)}</td>
                <td className="whitespace-nowrap">{formatDate(o.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <OffsetPager offset={offset} limit={LIMIT} count={rows.length} onChange={setOffset} />
    </div>
  );
}
