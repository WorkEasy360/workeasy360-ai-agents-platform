"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { BookOpen, Bot, Rocket, Wrench } from "lucide-react";
import { Card, Meter, PageHeader } from "@/components/ui";
import { api } from "@/lib/api";
import type { AgentListItem } from "@/lib/agents";
import { formatUsd, timeAgo } from "@/lib/format";
import { useMe } from "@/lib/use-me";

interface Usage {
  plan: { key: string; name: string };
  limits: { messagesPerMonth: number | null; platformCreditsUsdPerMonth: number | null; agents: number | null };
  summary: { messages: number; platformCreditsUsd: number; agents: number };
}

const steps = [
  { icon: Bot, title: "Create an agent", text: "Start from a template and describe what it should do.", href: "/agents" },
  { icon: BookOpen, title: "Add knowledge", text: "Upload FAQs, policies or product guides.", href: "/knowledge" },
  { icon: Wrench, title: "Connect tools", text: "Let it look up orders or create leads in your systems.", href: "/tools" },
  { icon: Rocket, title: "Go live", text: "Share a chat link, add the website widget or use the API.", href: "/agents" },
];

export default function HomePage() {
  const { data: me } = useMe();
  const { data: usage } = useQuery({ queryKey: ["usage"], queryFn: () => api<Usage>("/api/v1/usage") });
  const { data: agents } = useQuery({ queryKey: ["agents"], queryFn: () => api<{ data: AgentListItem[] }>("/api/v1/agents") });
  const firstName = me?.user.name.split(" ")[0];

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={`Welcome${firstName ? `, ${firstName}` : ""}`} description="Create AI agents that know your business and work around the clock." />

      {agents && agents.data.length === 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {steps.map((s, i) => (
            <Link key={s.title} href={s.href}>
              <Card className="h-full p-4 transition-colors hover:border-brand-500">
                <s.icon className="size-5 text-brand-600" aria-hidden />
                <p className="mt-3 text-sm font-medium">
                  {i + 1}. {s.title}
                </p>
                <p className="mt-1 text-xs text-[var(--muted)]">{s.text}</p>
              </Card>
            </Link>
          ))}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <Card>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-medium">Your agents</h2>
            <Link href="/agents" className="text-sm text-brand-600 hover:underline">
              View all
            </Link>
          </div>
          {agents?.data.length ? (
            <ul className="divide-y divide-[var(--border)]">
              {agents.data.slice(0, 5).map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                  <Link href={`/agents/${a.id}`} className="truncate font-medium hover:underline">
                    {a.name}
                  </Link>
                  <span className="shrink-0 text-xs text-[var(--muted)]">
                    {a.publishedVersionNo ? `v${a.publishedVersionNo} live` : "draft"} · {a.runs30d} conversations · {timeAgo(a.updatedAt)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-[var(--muted)]">
              No agents yet.{" "}
              <Link href="/agents" className="text-brand-600 hover:underline">
                Create your first one
              </Link>
              .
            </p>
          )}
        </Card>
        <Card className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="font-medium">This month</h2>
            {usage && <span className="text-xs text-[var(--muted)]">{usage.plan.name} plan</span>}
          </div>
          {usage && (
            <>
              <Meter label="Messages" used={usage.summary.messages} limit={usage.limits.messagesPerMonth} />
              <Meter label="AI credits" used={usage.summary.platformCreditsUsd} limit={usage.limits.platformCreditsUsdPerMonth} format={(n) => formatUsd(n, 2)} />
              <Meter label="Agents" used={usage.summary.agents} limit={usage.limits.agents} />
              <Link href="/usage" className="block text-sm text-brand-600 hover:underline">
                Usage details
              </Link>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
