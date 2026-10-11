"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Badge, Card, Loading, PageHeader, Select, Table } from "@/components/ui";
import { ADMIN_API, BarChart, QueryError, StatTile, fillDays } from "@/components/admin/shared";
import type { Usage } from "@/components/admin/types";
import { api } from "@/lib/api";
import { formatNumber, formatUsd } from "@/lib/format";

const RANGES = [7, 30, 90];

export default function AdminUsagePage() {
  const [days, setDays] = useState(30);
  const usage = useQuery({
    queryKey: ["admin", "usage", days],
    queryFn: () => api<Usage>(`${ADMIN_API}/usage?days=${days}`),
    placeholderData: (prev) => prev,
  });

  const d = usage.data;
  const byDay = d ? fillDays(d.byDay, days, (day) => ({ day, platform_usd: 0, byok_usd: 0 })) : [];
  const platformTotal = d?.byDay.reduce((s, r) => s + r.platform_usd, 0) ?? 0;
  const byokTotal = d?.byDay.reduce((s, r) => s + r.byok_usd, 0) ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Usage & cost"
        description="Model spend by day, model and organization."
        actions={
          <Select aria-label="Time range" value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-36">
            {RANGES.map((r) => (
              <option key={r} value={r}>
                Last {r} days
              </option>
            ))}
          </Select>
        }
      />

      {usage.error && <QueryError error={usage.error} />}
      {!d && !usage.error && <Loading />}

      {d && (
        <>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3">
            <StatTile label={`Platform cost (${days}d)`} value={formatUsd(platformTotal)} hint="Paid by us" />
            <StatTile label={`BYOK cost (${days}d)`} value={formatUsd(byokTotal)} hint="Paid by customers' own keys" />
            <StatTile label="Models used" value={formatNumber(new Set(d.byModel.map((m) => `${m.provider}/${m.model_key}`)).size)} />
          </div>

          <Card>
            <h2 className="font-medium">Cost per day</h2>
            <p className="mb-4 text-xs text-[var(--muted)]">Platform-billed and BYOK spend, stacked. Hover a bar for exact values.</p>
            <BarChart
              label="Cost per day, platform vs BYOK"
              rows={byDay}
              format={(n) => formatUsd(n)}
              series={[
                { key: "platform_usd", label: "Platform", className: "bg-brand-600 dark:bg-brand-500" },
                { key: "byok_usd", label: "BYOK", className: "bg-amber-600" },
              ]}
            />
          </Card>

          <section>
            <h2 className="mb-3 font-medium">By model</h2>
            <Table>
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Model</th>
                  <th>Kind</th>
                  <th>Billing</th>
                  <th className="text-right">Input tokens</th>
                  <th className="text-right">Output tokens</th>
                  <th className="text-right">Cost</th>
                </tr>
              </thead>
              <tbody>
                {d.byModel.length === 0 && (
                  <tr>
                    <td colSpan={7} className="text-[var(--muted)]">
                      No usage in this period.
                    </td>
                  </tr>
                )}
                {d.byModel.map((m) => (
                  <tr key={`${m.provider}/${m.model_key}/${m.billing_source}/${m.kind}`}>
                    <td className="capitalize">{m.provider}</td>
                    <td className="font-mono text-xs">{m.model_key}</td>
                    <td>{m.kind}</td>
                    <td>
                      <Badge tone={m.billing_source === "byok" ? "amber" : "blue"}>{m.billing_source}</Badge>
                    </td>
                    <td className="text-right tabular-nums">{formatNumber(Number(m.input_tokens))}</td>
                    <td className="text-right tabular-nums">{formatNumber(Number(m.output_tokens))}</td>
                    <td className="text-right tabular-nums">{formatUsd(m.cost_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </section>

          <section>
            <h2 className="mb-3 font-medium">Top organizations by platform cost</h2>
            <Table>
              <thead>
                <tr>
                  <th>Organization</th>
                  <th>Plan</th>
                  <th className="text-right">Runs</th>
                  <th className="text-right">Platform cost</th>
                </tr>
              </thead>
              <tbody>
                {d.topOrgs.length === 0 && (
                  <tr>
                    <td colSpan={4} className="text-[var(--muted)]">
                      No platform-billed usage in this period.
                    </td>
                  </tr>
                )}
                {d.topOrgs.map((o) => (
                  <tr key={o.org_id}>
                    <td>
                      <Link href={`/admin/organizations/${o.org_id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-100">
                        {o.name}
                      </Link>
                    </td>
                    <td className="capitalize">{o.plan_key}</td>
                    <td className="text-right tabular-nums">{formatNumber(o.runs)}</td>
                    <td className="text-right tabular-nums">{formatUsd(o.platform_usd)}</td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </section>
        </>
      )}
    </div>
  );
}
