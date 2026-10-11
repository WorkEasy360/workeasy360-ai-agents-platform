"use client";

import { useQuery } from "@tanstack/react-query";
import { Card, PageHeader } from "@/components/ui";
import { ADMIN_API, BarChart, QueryError, StatTile } from "@/components/admin/shared";
import type { Overview } from "@/components/admin/types";
import { api } from "@/lib/api";
import { formatNumber, formatUsd } from "@/lib/format";

export default function AdminOverviewPage() {
  const { data, error } = useQuery({ queryKey: ["admin", "overview"], queryFn: () => api<Overview>(`${ADMIN_API}/overview`) });

  if (error) return <QueryError error={error} />;

  const tiles: Array<{ label: string; value: string | undefined; danger?: boolean }> = [
    { label: "Organizations", value: data && formatNumber(data.organizations) },
    { label: "Suspended organizations", value: data && formatNumber(data.suspended_organizations), danger: Boolean(data?.suspended_organizations) },
    { label: "Users", value: data && formatNumber(data.users) },
    { label: "Signups (7 days)", value: data && formatNumber(data.signups_7d) },
    { label: "Active agents", value: data && formatNumber(data.active_agents) },
    { label: "Runs today", value: data && formatNumber(data.runs_today) },
    { label: "Runs (30 days)", value: data && formatNumber(data.runs_30d) },
    { label: "Failed runs today", value: data && formatNumber(data.failed_runs_today), danger: Boolean(data?.failed_runs_today) },
    { label: "Platform AI cost today", value: data && formatUsd(data.platform_cost_today_usd) },
    { label: "Platform AI cost this month", value: data && formatUsd(data.platform_cost_month_usd) },
    { label: "BYOK cost this month", value: data && formatUsd(data.byok_cost_month_usd) },
  ];

  return (
    <div>
      <PageHeader title="Overview" description="Platform-wide numbers across all organizations." />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {tiles.map((t) => (
          <StatTile key={t.label} label={t.label} value={t.value} tone={t.danger ? "danger" : undefined} />
        ))}
      </div>

      <Card className="mt-6">
        <h2 className="font-medium">Signups, last 30 days</h2>
        <p className="mb-4 text-xs text-[var(--muted)]">New user accounts per day.</p>
        {data ? (
          <BarChart label="Signups per day" rows={data.signupsDaily} series={[{ key: "n", label: "Signups", className: "bg-brand-600 dark:bg-brand-500" }]} />
        ) : (
          <div className="h-40" />
        )}
      </Card>
    </div>
  );
}
