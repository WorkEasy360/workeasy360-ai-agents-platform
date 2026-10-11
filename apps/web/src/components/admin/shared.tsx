"use client";

import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Button, Card, Dialog, Field, FormError, Textarea } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/cn";
import { useMe } from "@/lib/use-me";

/** Base path of the super admin API. */
export const ADMIN_API = "/api/admin/v1";

/** Builds a query string, dropping empty values. */
export function qs(params: Record<string, string | number | null | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") sp.set(k, String(v));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/** True when the signed-in user may perform super_admin-only actions (support is read-mostly). */
export function useIsSuperAdmin(): boolean {
  const { data } = useMe();
  return data?.user.platformRole === "super_admin";
}

/** Human message for an admin API error, with the 2FA requirement called out. */
export function errorText(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof ApiError) {
    if (error.code === "two_factor_required") return "Enable two-factor authentication on your account to use the admin dashboard.";
    if (error.status === 403) return "You don't have permission to do that.";
    return error.message;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
}

export function QueryError({ error }: { error: unknown }) {
  return <FormError message={errorText(error)} />;
}

export function StatTile({ label, value, hint, tone }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: "danger" }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-[var(--muted)]">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold tabular-nums", tone === "danger" && "text-red-600 dark:text-red-400")}>{value ?? "—"}</p>
      {hint && <p className="mt-0.5 text-xs text-[var(--muted)]">{hint}</p>}
    </Card>
  );
}

/** Collapsible pretty-printed JSON. */
export function JsonBlock({ label, value, defaultOpen = false }: { label: string; value: unknown; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const empty = value === null || value === undefined;
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        disabled={empty}
        className="inline-flex items-center gap-1 text-xs font-medium text-[var(--muted)] hover:text-[var(--foreground)] disabled:cursor-default disabled:hover:text-[var(--muted)]"
      >
        {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        {label}
        {empty && " (empty)"}
      </button>
      {open && !empty && (
        <pre className="mt-1 max-h-96 overflow-auto rounded-md border border-[var(--border)] bg-[var(--background)] p-3 text-xs leading-relaxed whitespace-pre-wrap break-all">
          {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
        </pre>
      )}
    </div>
  );
}

/**
 * Confirm dialog that collects a reason. `minLength` > 0 makes the reason required.
 * `onConfirm` should return the mutation promise; errors are shown inline.
 */
export function ReasonDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel,
  danger,
  minLength = 3,
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel: string;
  danger?: boolean;
  minLength?: number;
  pending?: boolean;
  error?: unknown;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const valid = reason.trim().length >= minLength;
  return (
    <Dialog
      open={open}
      onClose={() => {
        setReason("");
        onClose();
      }}
      title={title}
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) onConfirm(reason.trim());
        }}
      >
        {description && <p className="text-sm text-[var(--muted)]">{description}</p>}
        <Field label={minLength > 0 ? "Reason" : "Reason (optional)"} htmlFor="admin-reason" hint="Saved to the audit log.">
          <Textarea id="admin-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} required={minLength > 0} autoFocus />
        </Field>
        <FormError message={errorText(error)} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant={danger ? "danger" : "primary"} disabled={!valid || pending}>
            {pending ? "Working…" : confirmLabel}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** Prev/next pager for offset-paginated lists (the API returns no total, so "next" shows when the page is full). */
export function OffsetPager({ offset, limit, count, onChange }: { offset: number; limit: number; count: number; onChange: (offset: number) => void }) {
  if (offset === 0 && count < limit) return null;
  return (
    <div className="mt-4 flex items-center justify-between gap-2 text-sm text-[var(--muted)]">
      <span>
        {count === 0 ? "No results" : `Showing ${offset + 1}–${offset + count}`}
      </span>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
          Previous
        </Button>
        <Button variant="secondary" size="sm" disabled={count < limit} onClick={() => onChange(offset + limit)}>
          Next
        </Button>
      </div>
    </div>
  );
}

/** Row of filter controls above a list; wraps on small screens. */
export function FilterBar({ children, onSubmit }: { children: React.ReactNode; onSubmit?: () => void }) {
  return (
    <form
      className="mb-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit?.();
      }}
    >
      {children}
    </form>
  );
}

export interface BarSeries {
  key: string;
  label: string;
  /** Tailwind background classes for the series' fill. */
  className: string;
}

/**
 * Minimal vertical bar chart built from divs. One bar per row; multiple series stack.
 * Each bar has a native tooltip and the chart has a legend when there's more than one series.
 */
export function BarChart<T extends { day: string }>({
  rows,
  series,
  format = (n) => n.toLocaleString(),
  height = 160,
  label,
}: {
  rows: T[];
  series: BarSeries[];
  format?: (n: number) => string;
  height?: number;
  label: string;
}) {
  const value = (r: T, key: string) => Number((r as Record<string, unknown>)[key] ?? 0);
  const totals = rows.map((r) => series.reduce((s, x) => s + value(r, x.key), 0));
  const max = Math.max(0, ...totals);
  const shortDay = (d: string) => new Date(`${d}T00:00:00`).toLocaleDateString(undefined, { month: "short", day: "numeric" });

  return (
    <figure aria-label={label}>
      {series.length > 1 && (
        <div className="mb-3 flex flex-wrap gap-4 text-xs text-[var(--muted)]">
          {series.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span className={cn("size-2.5 rounded-sm", s.className)} aria-hidden />
              {s.label}
            </span>
          ))}
        </div>
      )}
      <div className="flex items-stretch gap-2">
        {/* y-axis max label */}
        <div className="flex w-12 shrink-0 flex-col justify-between text-right text-[10px] text-[var(--muted)] tabular-nums" style={{ height }}>
          <span>{format(max)}</span>
          <span>{format(0)}</span>
        </div>
        <div className="flex min-w-0 flex-1 items-end gap-0.5 border-b border-[var(--border)]" style={{ height }}>
          {rows.map((r, i) => {
            const total = totals[i]!;
            const tip = `${shortDay(r.day)}: ${series.map((s) => `${s.label} ${format(value(r, s.key))}`).join(", ")}`;
            return (
              <div key={r.day} title={tip} className="flex h-full min-w-0 flex-1 flex-col justify-end hover:bg-slate-100/60 dark:hover:bg-slate-800/60">
                {/* stacked segments, first series at the bottom; 1px gap between segments */}
                <div className="flex flex-col-reverse gap-px" style={{ height: max ? `${(total / max) * 100}%` : 0 }}>
                  {series.map((s, si) => {
                    const v = value(r, s.key);
                    if (!v) return null;
                    const top = series.slice(si + 1).every((x) => !value(r, x.key));
                    return <div key={s.key} className={cn(s.className, top && "rounded-t-sm")} style={{ flexGrow: v, flexBasis: 0, minHeight: 2 }} />;
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      {rows.length > 0 && (
        <div className="mt-1 ml-14 flex justify-between text-[10px] text-[var(--muted)]">
          <span>{shortDay(rows[0]!.day)}</span>
          <span>{shortDay(rows.at(-1)!.day)}</span>
        </div>
      )}
    </figure>
  );
}

/** Fill missing days with zeros so a chart shows a continuous range ending today (UTC). */
export function fillDays<T extends { day: string }>(rows: T[], days: number, empty: (day: string) => T): T[] {
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const out: T[] = [];
  // The API buckets days in the database timezone (UTC), so build keys in UTC too.
  const now = Date.now();
  for (let i = days - 1; i >= 0; i--) {
    const key = new Date(now - i * 86_400_000).toISOString().slice(0, 10);
    out.push(byDay.get(key) ?? empty(key));
  }
  return out;
}
