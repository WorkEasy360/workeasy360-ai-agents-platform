"use client";

import { forwardRef, useEffect, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "primary", size = "md", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium whitespace-nowrap transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:pointer-events-none disabled:opacity-50",
        size === "md" ? "h-9 px-4 text-sm" : "h-8 px-3 text-xs",
        variant === "primary" && "bg-brand-600 text-white hover:bg-brand-700",
        variant === "secondary" && "border border-[var(--border)] bg-[var(--surface)] hover:bg-slate-100 dark:hover:bg-slate-800",
        variant === "ghost" && "hover:bg-slate-100 dark:hover:bg-slate-800",
        variant === "danger" && "bg-red-600 text-white hover:bg-red-700",
        className,
      )}
      {...props}
    />
  );
});

const fieldBase =
  "w-full rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-sm placeholder:text-[var(--muted)] focus:outline-2 focus:outline-brand-500 disabled:opacity-60";

export const Input = forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input(
  { className, ...props },
  ref,
) {
  return <input ref={ref} className={cn(fieldBase, "h-9", className)} {...props} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea(
  { className, ...props },
  ref,
) {
  return <textarea ref={ref} className={cn(fieldBase, "min-h-24 py-2 leading-relaxed", className)} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function Select(
  { className, ...props },
  ref,
) {
  return <select ref={ref} className={cn(fieldBase, "h-9 pr-8", className)} {...props} />;
});

export function Label({ className, ...props }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn("mb-1.5 block text-sm font-medium", className)} {...props} />;
}

export function Hint({ children }: { children: React.ReactNode }) {
  return <p className="mt-1 text-xs text-[var(--muted)]">{children}</p>;
}

export function Field({ label, hint, htmlFor, children }: { label: string; hint?: React.ReactNode; htmlFor?: string; children: React.ReactNode }) {
  return (
    <div>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <Hint>{hint}</Hint>}
    </div>
  );
}

export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border border-[var(--border)] bg-[var(--surface)] p-6 shadow-sm", className)} {...props} />;
}

export function FormError({ message }: { message?: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300">
      {message}
    </p>
  );
}

export function Notice({ tone = "info", children }: { tone?: "info" | "warning" | "success"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-md px-3 py-2 text-sm",
        tone === "info" && "bg-brand-50 text-brand-700 dark:bg-slate-800 dark:text-slate-200",
        tone === "warning" && "bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200",
        tone === "success" && "bg-green-50 text-green-800 dark:bg-green-950 dark:text-green-200",
      )}
    >
      {children}
    </div>
  );
}

const badgeTones = {
  neutral: "bg-slate-100 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
  green: "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300",
  red: "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300",
  amber: "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300",
  blue: "bg-brand-100 text-brand-700 dark:bg-slate-800 dark:text-brand-100",
};

export function Badge({ tone = "neutral", children, className }: { tone?: keyof typeof badgeTones; children: React.ReactNode; className?: string }) {
  return <span className={cn("inline-flex items-center rounded px-1.5 py-0.5 text-xs font-medium", badgeTones[tone], className)}>{children}</span>;
}

/** Maps common status strings to badge colors. */
export function StatusBadge({ status }: { status: string }) {
  const tone =
    status === "succeeded" || status === "active" || status === "ready"
      ? "green"
      : status === "failed" || status === "suspended" || status === "disabled_by_admin"
        ? "red"
        : status === "limited" || status === "paused" || status === "disabled" || status === "queued"
          ? "amber"
          : status === "running" || status === "parsing" || status === "embedding"
            ? "blue"
            : "neutral";
  return <Badge tone={tone}>{status.replace(/_/g, " ")}</Badge>;
}

export function PageHeader({ title, description, actions }: { title: string; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h1 className="truncate text-2xl font-semibold">{title}</h1>
        {description && <p className="mt-1 text-sm text-[var(--muted)]">{description}</p>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, description, action }: { icon?: React.ComponentType<{ className?: string }>; title: string; description?: string; action?: React.ReactNode }) {
  return (
    <Card className="flex flex-col items-center py-12 text-center">
      {Icon && <Icon className="size-10 text-brand-600" />}
      <h2 className="mt-4 font-medium">{title}</h2>
      {description && <p className="mt-1 max-w-sm text-sm text-[var(--muted)]">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </Card>
  );
}

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <p className="py-6 text-sm text-[var(--muted)]">{label}</p>;
}

/** Simple table wrapper: pass <thead>/<tbody> children. Scrolls horizontally on small screens. */
export function Table({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--surface)]", className)}>
      <table className="w-full text-sm [&_td]:px-4 [&_td]:py-2.5 [&_th]:px-4 [&_th]:py-2.5 [&_th]:text-left [&_th]:font-medium [&_th]:text-[var(--muted)] [&_thead]:border-b [&_thead]:border-[var(--border)] [&_tbody_tr]:border-b [&_tbody_tr]:border-[var(--border)] [&_tbody_tr:last-child]:border-0">
        {children}
      </table>
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: Array<{ value: T; label: string }> }) {
  return (
    <div role="tablist" className="flex gap-1 overflow-x-auto border-b border-[var(--border)]">
      {items.map((it) => (
        <button
          key={it.value}
          role="tab"
          aria-selected={value === it.value}
          onClick={() => onChange(it.value)}
          className={cn(
            "-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap",
            value === it.value ? "border-brand-600 font-medium text-brand-700 dark:text-white" : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]",
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

/** Modal dialog using the native <dialog> element (focus trap and Esc handling built in). */
export function Dialog({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: React.ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      onClick={(e) => e.target === ref.current && onClose()}
      className={cn(
        "m-auto w-[calc(100%-2rem)] rounded-lg border border-[var(--border)] bg-[var(--surface)] p-0 text-[var(--foreground)] shadow-xl backdrop:bg-black/40",
        wide ? "max-w-2xl" : "max-w-md",
      )}
    >
      <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-3">
        <h2 className="font-medium">{title}</h2>
        <button onClick={onClose} aria-label="Close" className="rounded p-1 hover:bg-slate-100 dark:hover:bg-slate-800">
          <X className="size-4" />
        </button>
      </div>
      <div className="max-h-[75vh] overflow-y-auto p-5">{children}</div>
    </dialog>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <label className={cn("inline-flex cursor-pointer items-center gap-2 text-sm", disabled && "cursor-not-allowed opacity-60")}>
      <span
        role="switch"
        aria-checked={checked}
        tabIndex={0}
        onKeyDown={(e) => (e.key === " " || e.key === "Enter") && !disabled && onChange(!checked)}
        onClick={() => !disabled && onChange(!checked)}
        className={cn("relative h-5 w-9 rounded-full transition-colors", checked ? "bg-brand-600" : "bg-slate-300 dark:bg-slate-600")}
      >
        <span className={cn("absolute top-0.5 size-4 rounded-full bg-white shadow transition-transform", checked ? "translate-x-4.5" : "translate-x-0.5")} />
      </span>
      {label}
    </label>
  );
}

/** Horizontal usage bar: used / limit (null limit = unlimited). */
export function Meter({ label, used, limit, format = (n: number) => n.toLocaleString() }: { label: string; used: number; limit: number | null; format?: (n: number) => string }) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <div>
      <div className="mb-1 flex justify-between text-sm">
        <span>{label}</span>
        <span className="tabular-nums text-[var(--muted)]">
          {format(used)} / {limit === null ? "Unlimited" : format(limit)}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-slate-100 dark:bg-slate-800">
        <div className={cn("h-full rounded-full", pct >= 90 ? "bg-red-500" : pct >= 75 ? "bg-amber-500" : "bg-brand-500")} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}
