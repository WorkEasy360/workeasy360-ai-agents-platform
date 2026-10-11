"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Badge, Button, Card, Field, FormError, Hint, Input, Loading, Meter, Notice, PageHeader, Select, StatusBadge, Table } from "@/components/ui";
import { AgentActions } from "@/components/admin/agent-actions";
import { ADMIN_API, QueryError, ReasonDialog, errorText, useIsSuperAdmin } from "@/components/admin/shared";
import { NUMERIC_LIMITS, type OrgDetail, type Page, type Plan, type PlanLimits } from "@/components/admin/types";
import { api } from "@/lib/api";
import { formatDate, formatNumber, formatUsd, timeAgo } from "@/lib/format";

type OrgPatch = { planKey?: string; status?: "active" | "suspended"; planOverrides?: Record<string, unknown> | null; reason?: string };

export default function AdminOrganizationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const isSuper = useIsSuperAdmin();
  const [statusDialog, setStatusDialog] = useState(false);

  const org = useQuery({ queryKey: ["admin", "org", id], queryFn: () => api<OrgDetail>(`${ADMIN_API}/organizations/${id}`) });
  const plans = useQuery({ queryKey: ["admin", "plans"], queryFn: () => api<Page<Plan>>(`${ADMIN_API}/plans`) });

  const patch = useMutation({
    mutationFn: (body: OrgPatch) => api(`${ADMIN_API}/organizations/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: ["admin", "org", id] }),
        qc.invalidateQueries({ queryKey: ["admin", "orgs"] }),
        qc.invalidateQueries({ queryKey: ["admin", "overview"] }),
      ]),
  });
  // Separate mutation so the suspend dialog's error doesn't show in the plan card.
  const statusChange = useMutation({
    mutationFn: (body: OrgPatch) => api(`${ADMIN_API}/organizations/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: async () => {
      setStatusDialog(false);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["admin", "org", id] }),
        qc.invalidateQueries({ queryKey: ["admin", "orgs"] }),
        qc.invalidateQueries({ queryKey: ["admin", "overview"] }),
      ]);
    },
  });

  if (org.error) return <QueryError error={org.error} />;
  if (!org.data) return <Loading />;
  const o = org.data;
  const suspended = o.status === "suspended";

  // Effective limits = plan limits with per-org overrides on top (same rule as the API).
  const limits: Partial<PlanLimits> = { ...(o.plan?.limits ?? {}), ...(o.planOverrides ?? {}) };
  const usage = o.usageThisMonth;

  return (
    <div className="space-y-6">
      <Link href="/admin/organizations" className="inline-flex items-center gap-1 text-sm text-[var(--muted)] hover:text-[var(--foreground)]">
        <ArrowLeft className="size-4" /> Organizations
      </Link>

      <PageHeader
        title={o.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>{o.slug}</span>
            <StatusBadge status={o.status} />
            <Badge tone="blue">{o.plan?.name ?? o.planKey}</Badge>
            <span>Created {formatDate(o.createdAt)}</span>
          </span>
        }
        actions={
          isSuper && (
            <Button variant={suspended ? "primary" : "danger"} onClick={() => setStatusDialog(true)}>
              {suspended ? "Reactivate" : "Suspend"}
            </Button>
          )
        }
      />

      {suspended && <Notice tone="warning">This organization is suspended. Its members can't use agents until it's reactivated.</Notice>}

      <Card>
        <h2 className="font-medium">Usage this month</h2>
        <p className="mb-4 text-xs text-[var(--muted)]">Measured against the effective limits (plan plus overrides).</p>
        <div className="grid gap-5 md:grid-cols-2">
          <Meter label="Messages" used={usage.messages} limit={limits.messagesPerMonth ?? null} />
          <Meter label="Platform credits" used={Number(usage.platform_usd)} limit={limits.platformCreditsUsdPerMonth ?? null} format={(n) => formatUsd(n)} />
          <Meter label="Knowledge storage" used={Number(usage.storage_mb)} limit={limits.knowledgeStorageMb ?? null} format={(n) => `${n < 10 ? n.toFixed(2) : Math.round(n)} MB`} />
          <Meter label="Agents" used={o.agents.length} limit={limits.agents ?? null} />
          <Meter label="Members" used={o.members.length} limit={limits.members ?? null} />
          <div className="text-sm">
            <p>
              BYOK cost this month: <span className="font-medium tabular-nums">{formatUsd(usage.byok_usd)}</span>
            </p>
            <p className="mt-1 text-[var(--muted)]">
              BYOK providers: {o.byokProviders.length ? o.byokProviders.join(", ") : "none"}
            </p>
          </div>
        </div>
      </Card>

      <PlanCard
        key={`${o.planKey}:${JSON.stringify(o.planOverrides)}`}
        org={o}
        plans={plans.data?.data ?? []}
        editable={isSuper}
        pending={patch.isPending}
        error={patch.error}
        saved={patch.isSuccess}
        onSave={(body) => patch.mutate(body)}
      />

      <section>
        <h2 className="mb-3 font-medium">Members ({o.members.length})</h2>
        <Table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Joined</th>
            </tr>
          </thead>
          <tbody>
            {o.members.length === 0 && (
              <tr>
                <td colSpan={4} className="text-[var(--muted)]">
                  No members.
                </td>
              </tr>
            )}
            {o.members.map((m) => (
              <tr key={m.userId}>
                <td>
                  <Link href={`/admin/users/${m.userId}`} className="font-medium text-brand-700 hover:underline dark:text-brand-100">
                    {m.name}
                  </Link>
                </td>
                <td>{m.email}</td>
                <td className="capitalize">{m.role}</td>
                <td className="whitespace-nowrap">{formatDate(m.joinedAt)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>

      <section>
        <h2 className="mb-3 font-medium">Agents ({o.agents.length})</h2>
        <Table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Status</th>
              <th>Updated</th>
              <th className="text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {o.agents.length === 0 && (
              <tr>
                <td colSpan={4} className="text-[var(--muted)]">
                  No agents.
                </td>
              </tr>
            )}
            {o.agents.map((a) => (
              <tr key={a.id}>
                <td className="font-medium">
                  <Link href={`/admin/executions?agentId=${a.id}`} className="hover:underline" title="View executions">
                    {a.name}
                  </Link>
                </td>
                <td>
                  <StatusBadge status={a.disabledByAdminAt ? "disabled_by_admin" : a.status} />
                </td>
                <td className="whitespace-nowrap">{timeAgo(a.updatedAt)}</td>
                <td className="text-right">
                  <AgentActions agent={a} />
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>

      <ReasonDialog
        open={statusDialog}
        onClose={() => {
          setStatusDialog(false);
          statusChange.reset();
        }}
        title={suspended ? `Reactivate ${o.name}` : `Suspend ${o.name}`}
        description={
          suspended ? "Members regain access and agents resume serving traffic." : "Members lose access and every agent in this organization stops serving traffic."
        }
        confirmLabel={suspended ? "Reactivate" : "Suspend organization"}
        danger={!suspended}
        minLength={suspended ? 0 : 3}
        pending={statusChange.isPending}
        error={statusChange.error}
        onConfirm={(reason) => statusChange.mutate({ status: suspended ? "active" : "suspended", reason: reason || undefined })}
      />
    </div>
  );
}

type OverrideField = { value: string; unlimited: boolean };

/** Plan selector plus per-org numeric limit overrides. Blank = use the plan's value. */
function PlanCard({
  org,
  plans,
  editable,
  pending,
  error,
  saved,
  onSave,
}: {
  org: OrgDetail;
  plans: Plan[];
  editable: boolean;
  pending: boolean;
  error: unknown;
  saved: boolean;
  onSave: (body: OrgPatch) => void;
}) {
  const overrides = (org.planOverrides ?? {}) as Record<string, unknown>;
  const [planKey, setPlanKey] = useState(org.planKey);
  const [reason, setReason] = useState("");
  const [fields, setFields] = useState<Record<string, OverrideField>>(() =>
    Object.fromEntries(
      NUMERIC_LIMITS.map(({ key }) => {
        const has = key in overrides;
        const v = overrides[key];
        return [key, { value: has && typeof v === "number" ? String(v) : "", unlimited: has && v === null }];
      }),
    ),
  );
  const [localError, setLocalError] = useState<string | null>(null);
  const selectedPlan = plans.find((p) => p.key === planKey) ?? org.plan;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);
    // Keep non-numeric overrides (e.g. modelTiers) that this form doesn't edit.
    const next: Record<string, unknown> = Object.fromEntries(Object.entries(overrides).filter(([k]) => !NUMERIC_LIMITS.some((l) => l.key === k)));
    for (const { key, label, nullable } of NUMERIC_LIMITS) {
      const f = fields[key]!;
      if (nullable && f.unlimited) next[key] = null;
      else if (f.value.trim() !== "") {
        const n = Number(f.value);
        if (!Number.isFinite(n) || n < 0) return setLocalError(`${label} must be a non-negative number.`);
        next[key] = n;
      }
    }
    onSave({
      planKey: planKey !== org.planKey ? planKey : undefined,
      planOverrides: Object.keys(next).length ? next : null,
      reason: reason.trim() || undefined,
    });
  }

  const planValue = (key: keyof PlanLimits) => {
    const v = selectedPlan?.limits[key];
    return v === null ? "Unlimited" : v === undefined ? "—" : String(v);
  };

  return (
    <Card>
      <form onSubmit={submit} className="space-y-5">
        <div>
          <h2 className="font-medium">Plan and limit overrides</h2>
          <p className="text-xs text-[var(--muted)]">
            Overrides apply on top of the plan for this organization only. Leave a field blank to use the plan&apos;s value.
          </p>
        </div>
        {!editable && <Notice>Only super admins can change plans and limits.</Notice>}

        <Field label="Plan" htmlFor="org-plan">
          <Select id="org-plan" className="sm:w-64" value={planKey} disabled={!editable} onChange={(e) => setPlanKey(e.target.value)}>
            {plans.length === 0 && <option value={org.planKey}>{org.plan?.name ?? org.planKey}</option>}
            {plans.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
                {p.isPublic ? "" : " (hidden)"}
              </option>
            ))}
          </Select>
        </Field>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {NUMERIC_LIMITS.map(({ key, label, step, nullable }) => {
            const f = fields[key]!;
            const set = (patch: Partial<OverrideField>) => setFields((s) => ({ ...s, [key]: { ...f, ...patch } }));
            return (
              <div key={key}>
                <Field label={label} htmlFor={`ov-${key}`}>
                  <Input
                    id={`ov-${key}`}
                    type="number"
                    min={0}
                    step={step ?? "1"}
                    inputMode="decimal"
                    placeholder={`Plan: ${planValue(key)}`}
                    value={f.unlimited ? "" : f.value}
                    disabled={!editable || f.unlimited}
                    onChange={(e) => set({ value: e.target.value })}
                  />
                </Field>
                {nullable && (
                  <label className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-[var(--muted)]">
                    <input type="checkbox" checked={f.unlimited} disabled={!editable} onChange={(e) => set({ unlimited: e.target.checked })} />
                    Unlimited
                  </label>
                )}
              </div>
            );
          })}
        </div>

        {editable && (
          <>
            <Field label="Reason (optional)" htmlFor="org-reason">
              <Input id="org-reason" maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Enterprise trial extension" />
              <Hint>Saved to the audit log.</Hint>
            </Field>
            <FormError message={localError ?? errorText(error)} />
            {saved && !pending && !error && <p className="text-sm text-green-700 dark:text-green-400">Saved.</p>}
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save plan and limits"}
            </Button>
          </>
        )}
        <p className="text-xs text-[var(--muted)]">
          Current overrides: {org.planOverrides && Object.keys(org.planOverrides).length ? formatNumber(Object.keys(org.planOverrides).length) : "none"}
        </p>
      </form>
    </Card>
  );
}
