"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Flag } from "lucide-react";
import { Card, EmptyState, FormError, Loading, Notice, PageHeader, Toggle } from "@/components/ui";
import { ADMIN_API, QueryError, errorText, useIsSuperAdmin } from "@/components/admin/shared";
import type { FeatureFlag, Page } from "@/components/admin/types";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";

const KEY = ["admin", "feature-flags"];

export default function AdminFeatureFlagsPage() {
  const qc = useQueryClient();
  const isSuper = useIsSuperAdmin();
  const flags = useQuery({ queryKey: KEY, queryFn: () => api<Page<FeatureFlag>>(`${ADMIN_API}/feature-flags`) });
  const update = useMutation({
    mutationFn: ({ key, defaultEnabled }: { key: string; defaultEnabled: boolean }) =>
      api(`${ADMIN_API}/feature-flags/${encodeURIComponent(key)}`, { method: "PATCH", body: JSON.stringify({ defaultEnabled }) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });

  return (
    <div>
      <PageHeader title="Feature flags" description="Platform-wide switches. Per-organization overrides take precedence over the default." />
      {!isSuper && (
        <div className="mb-4">
          <Notice>Only super admins can change feature flags.</Notice>
        </div>
      )}
      <div className="mb-4">
        <FormError message={errorText(update.error)} />
      </div>

      {flags.error ? (
        <QueryError error={flags.error} />
      ) : !flags.data ? (
        <Loading />
      ) : flags.data.data.length === 0 ? (
        <EmptyState icon={Flag} title="No feature flags defined" />
      ) : (
        <Card className="divide-y divide-[var(--border)] p-0">
          {flags.data.data.map((f) => {
            const overrides = Object.keys(f.orgOverrides ?? {}).length;
            return (
              <div key={f.key} className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="font-mono text-sm font-medium">{f.key}</p>
                  {f.description && <p className="mt-0.5 text-sm text-[var(--muted)]">{f.description}</p>}
                  <p className="mt-1 text-xs text-[var(--muted)]">
                    {overrides ? `${overrides} organization override${overrides === 1 ? "" : "s"}` : "No organization overrides"} · updated {timeAgo(f.updatedAt)}
                  </p>
                </div>
                <Toggle
                  checked={f.defaultEnabled}
                  disabled={!isSuper || (update.isPending && update.variables?.key === f.key)}
                  onChange={(v) => update.mutate({ key: f.key, defaultEnabled: v })}
                  label={f.defaultEnabled ? "On by default" : "Off by default"}
                />
              </div>
            );
          })}
        </Card>
      )}
    </div>
  );
}
