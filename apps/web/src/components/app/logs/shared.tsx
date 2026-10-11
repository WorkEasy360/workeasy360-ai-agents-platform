"use client";

import { useQuery } from "@tanstack/react-query";
import { Select } from "@/components/ui";
import type { AgentSummary } from "@/components/app/types";
import { api } from "@/lib/api";

export function useAgents() {
  return useQuery({ queryKey: ["agents"], queryFn: () => api<{ data: AgentSummary[] }>("/api/v1/agents") });
}

export function AgentFilter({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const agents = useAgents();
  return (
    <Select aria-label="Agent" value={value} onChange={(e) => onChange(e.target.value)} className="sm:w-48">
      <option value="">All agents</option>
      {agents.data?.data.map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </Select>
  );
}

/** Builds a query string from non-empty values. */
export function qs(params: Record<string, string | undefined>) {
  const s = new URLSearchParams(Object.entries(params).filter((e): e is [string, string] => !!e[1])).toString();
  return s ? `?${s}` : "";
}
