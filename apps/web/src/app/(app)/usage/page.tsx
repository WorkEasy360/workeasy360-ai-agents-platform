"use client";

import { useQuery } from "@tanstack/react-query";
import { Card, FormError, Loading, Meter, Notice, PageHeader } from "@/components/ui";
import { DailyBars } from "@/components/app/daily-bars";
import { errorMessage } from "@/components/app/misc";
import { api } from "@/lib/api";
import { formatDate, formatUsd } from "@/lib/format";

interface Usage {
  plan: { key: string; name: string };
  limits: {
    agents: number | null;
    messagesPerMonth: number | null;
    platformCreditsUsdPerMonth: number | null;
    knowledgeStorageMb: number | null;
    logRetentionDays: number;
  };
  summary: { periodStart: string; messages: number; platformCreditsUsd: number; byokCostUsd: number; agents: number; storageMb: number };
  daily: {
    runs: Array<{ day: string; messages: number; tests: number; failed: number }>;
    cost: Array<{ day: string; platformUsd: number; byokUsd: number; tokens: number }>;
  };
}

/** Last 30 days (oldest first) as YYYY-MM-DD in UTC, matching the API's day buckets. */
function last30Days(): string[] {
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  return Array.from({ length: 30 }, (_, i) => new Date(today - (29 - i) * 86_400_000).toISOString().slice(0, 10));
}

const mb = (n: number) => (n < 1 ? `${(n * 1024).toFixed(0)} KB` : `${n.toFixed(1)} MB`);

export default function UsagePage() {
  const { data, isLoading, error } = useQuery({ queryKey: ["usage"], queryFn: () => api<Usage>("/api/v1/usage") });

  if (isLoading) return <Loading />;
  if (!data) return <FormError message={errorMessage(error)} />;

  const { plan, limits, summary, daily } = data;
  const days = last30Days();
  const runsByDay = new Map(daily.runs.map((r) => [r.day, r]));
  const costByDay = new Map(daily.cost.map((c) => [c.day, c]));

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title="Usage" description={`Your ${plan.name} plan. Monthly totals since ${formatDate(summary.periodStart)}.`} />

      <Card>
        <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="font-medium">This month</h2>
          <span className="rounded-full bg-brand-50 px-2.5 py-0.5 text-sm font-medium text-brand-700 dark:bg-slate-800 dark:text-brand-100">{plan.name} plan</span>
        </div>
        <div className="grid gap-6 sm:grid-cols-2">
          <Meter label="Messages" used={summary.messages} limit={limits.messagesPerMonth} />
          <Meter label="AI credits" used={summary.platformCreditsUsd} limit={limits.platformCreditsUsdPerMonth} format={(n) => formatUsd(n, 2)} />
          <Meter label="Agents" used={summary.agents} limit={limits.agents} />
          <Meter label="Knowledge storage" used={summary.storageMb} limit={limits.knowledgeStorageMb} format={mb} />
        </div>
        <p className="mt-5 text-xs text-[var(--muted)]">
          Messages are replies your agents send through the hosted page, website widget or API. Test chats while building don&apos;t count.
        </p>
        {summary.byokCostUsd > 0 && (
          <div className="mt-4">
            <Notice>
              You also used about <strong>{formatUsd(summary.byokCostUsd)}</strong> of AI with your own provider keys this month. That&apos;s billed by the provider directly and doesn&apos;t use your
              credits.
            </Notice>
          </div>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <h2 className="font-medium">Messages per day</h2>
          <p className="mb-4 text-xs text-[var(--muted)]">Last 30 days</p>
          <DailyBars
            days={days}
            series={[{ label: "Messages", className: "bg-brand-500", values: days.map((d) => runsByDay.get(d)?.messages ?? 0) }]}
            format={(n) => n.toLocaleString()}
          />
        </Card>
        <Card>
          <h2 className="font-medium">AI cost per day</h2>
          <p className="mb-4 text-xs text-[var(--muted)]">Last 30 days</p>
          <DailyBars
            days={days}
            series={[
              { label: "Platform credits", className: "bg-brand-500", values: days.map((d) => costByDay.get(d)?.platformUsd ?? 0) },
              { label: "Your own keys", className: "bg-slate-400 dark:bg-slate-500", values: days.map((d) => costByDay.get(d)?.byokUsd ?? 0) },
            ]}
            format={(n) => formatUsd(n)}
          />
        </Card>
      </div>

      <Notice>
        <strong>Need more?</strong> Contact us to upgrade your plan for more messages, AI credits, agents and storage.
      </Notice>
    </div>
  );
}
