"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Card, Field, FormError, Input, Loading, Notice, PageHeader, Toggle } from "@/components/ui";
import { ADMIN_API, QueryError, errorText, useIsSuperAdmin } from "@/components/admin/shared";
import { CHANNELS, MODEL_TIERS, NUMERIC_LIMITS, type Page, type Plan, type PlanLimits } from "@/components/admin/types";
import { api } from "@/lib/api";

export default function AdminPlansPage() {
  const isSuper = useIsSuperAdmin();
  const plans = useQuery({ queryKey: ["admin", "plans"], queryFn: () => api<Page<Plan>>(`${ADMIN_API}/plans`) });

  return (
    <div>
      <PageHeader title="Plans" description="Limits for each subscription plan. Changes apply to every organization on the plan immediately." />
      {!isSuper && (
        <div className="mb-4">
          <Notice>Only super admins can edit plans.</Notice>
        </div>
      )}
      {plans.error ? (
        <QueryError error={plans.error} />
      ) : !plans.data ? (
        <Loading />
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {plans.data.data.map((p) => (
            <PlanEditor key={p.key} plan={p} editable={isSuper} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Numeric limits are edited as strings; blank = unlimited where allowed. */
type Draft = Omit<PlanLimits, "agents" | "messagesPerMonth" | "platformCreditsUsdPerMonth" | "knowledgeStorageMb" | "members" | "logRetentionDays"> & {
  numbers: Record<string, string>;
};

function toDraft(l: PlanLimits): Draft {
  return {
    modelTiers: l.modelTiers,
    channels: l.channels,
    removeBranding: l.removeBranding,
    numbers: Object.fromEntries(NUMERIC_LIMITS.map(({ key }) => [key, l[key] === null || l[key] === undefined ? "" : String(l[key])])),
  };
}

function toggle<T>(list: T[], item: T, on: boolean): T[] {
  return on ? (list.includes(item) ? list : [...list, item]) : list.filter((x) => x !== item);
}

function PlanEditor({ plan, editable }: { plan: Plan; editable: boolean }) {
  const qc = useQueryClient();
  const [name, setName] = useState(plan.name);
  const [isPublic, setIsPublic] = useState(plan.isPublic);
  const [draft, setDraft] = useState<Draft>(() => toDraft(plan.limits));
  const [localError, setLocalError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: { name: string; isPublic: boolean; limits: PlanLimits }) =>
      api<Plan>(`${ADMIN_API}/plans/${plan.key}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["admin", "plans"] }),
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);
    const numbers: Record<string, number | null> = {};
    for (const { key, label, nullable } of NUMERIC_LIMITS) {
      const raw = draft.numbers[key]!.trim();
      if (raw === "") {
        if (!nullable) return setLocalError(`${label} is required.`);
        numbers[key] = null;
        continue;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return setLocalError(`${label} must be a non-negative number.`);
      numbers[key] = n;
    }
    if (draft.modelTiers.length === 0) return setLocalError("Select at least one model tier.");
    save.mutate({
      name: name.trim(),
      isPublic,
      limits: { ...(numbers as unknown as PlanLimits), modelTiers: draft.modelTiers, channels: draft.channels, removeBranding: draft.removeBranding },
    });
  }

  return (
    <Card>
      <form onSubmit={submit} className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">
            {plan.name} <span className="font-mono text-xs text-[var(--muted)]">{plan.key}</span>
          </h2>
          <Toggle checked={isPublic} onChange={setIsPublic} disabled={!editable} label="Public" />
        </div>

        <Field label="Display name" htmlFor={`${plan.key}-name`}>
          <Input id={`${plan.key}-name`} value={name} maxLength={60} required disabled={!editable} onChange={(e) => setName(e.target.value)} />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          {NUMERIC_LIMITS.map(({ key, label, step, nullable }) => (
            <Field key={key} label={label} htmlFor={`${plan.key}-${key}`}>
              <Input
                id={`${plan.key}-${key}`}
                type="number"
                min={key === "logRetentionDays" || key === "members" ? 1 : 0}
                step={step ?? "1"}
                placeholder={nullable ? "Unlimited" : undefined}
                required={!nullable}
                disabled={!editable}
                value={draft.numbers[key]}
                onChange={(e) => setDraft((d) => ({ ...d, numbers: { ...d.numbers, [key]: e.target.value } }))}
              />
            </Field>
          ))}
        </div>
        <p className="text-xs text-[var(--muted)]">Leave a limit blank for unlimited.</p>

        <CheckboxGroup
          legend="Model tiers"
          options={MODEL_TIERS}
          value={draft.modelTiers}
          disabled={!editable}
          onChange={(item, on) => setDraft((d) => ({ ...d, modelTiers: toggle(d.modelTiers, item, on) }))}
        />
        <CheckboxGroup
          legend="Channels"
          options={CHANNELS}
          value={draft.channels}
          disabled={!editable}
          onChange={(item, on) => setDraft((d) => ({ ...d, channels: toggle(d.channels, item, on) }))}
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={draft.removeBranding} disabled={!editable} onChange={(e) => setDraft((d) => ({ ...d, removeBranding: e.target.checked }))} />
          Can remove &ldquo;Powered by&rdquo; branding
        </label>

        {editable && (
          <>
            <FormError message={localError ?? errorText(save.error)} />
            {save.isSuccess && <p className="text-sm text-green-700 dark:text-green-400">Saved.</p>}
            <Button type="submit" disabled={save.isPending}>
              {save.isPending ? "Saving…" : `Save ${plan.name}`}
            </Button>
          </>
        )}
      </form>
    </Card>
  );
}

function CheckboxGroup<T extends string>({
  legend,
  options,
  value,
  disabled,
  onChange,
}: {
  legend: string;
  options: T[];
  value: T[];
  disabled?: boolean;
  onChange: (item: T, on: boolean) => void;
}) {
  return (
    <fieldset>
      <legend className="mb-1.5 text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {options.map((o) => (
          <label key={o} className="inline-flex items-center gap-1.5 text-sm">
            <input type="checkbox" checked={value.includes(o)} disabled={disabled} onChange={(e) => onChange(o, e.target.checked)} />
            {o.replace(/_/g, " ")}
          </label>
        ))}
      </div>
    </fieldset>
  );
}
