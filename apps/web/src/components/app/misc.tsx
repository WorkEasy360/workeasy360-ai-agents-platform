"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button, Dialog, FormError } from "@/components/ui";
import { ApiError } from "@/lib/api";

/** Human-readable message for any thrown error. */
export function errorMessage(err: unknown, fallback = "Something went wrong. Please try again."): string | null {
  if (!err) return null;
  if (err instanceof ApiError) return err.errors?.length ? `${err.message} ${err.errors.map((e) => e.message).join(" ")}` : err.message;
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/** Pretty-printed JSON in a scrollable block. */
export function JsonBlock({ value }: { value: unknown }) {
  if (value === null || value === undefined) return <p className="text-xs text-[var(--muted)]">Nothing recorded.</p>;
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <pre className="max-h-80 overflow-auto rounded-md bg-slate-50 p-3 text-xs leading-relaxed break-words whitespace-pre-wrap dark:bg-slate-900">
      {text}
    </pre>
  );
}

export function CopyBox({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-slate-50 p-2 dark:bg-slate-900">
      <code className="min-w-0 flex-1 truncate font-mono text-xs select-all">{value}</code>
      <Button
        size="sm"
        variant="secondary"
        onClick={async () => {
          await navigator.clipboard.writeText(value).catch(() => undefined);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

/** Yes/no confirmation for destructive actions. */
export function ConfirmDialog({
  open,
  onClose,
  title,
  message,
  confirmLabel = "Delete",
  pending,
  error,
  onConfirm,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  message: React.ReactNode;
  confirmLabel?: string;
  pending?: boolean;
  error?: string | null;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title={title}>
      <div className="space-y-4">
        <div className="text-sm">{message}</div>
        <FormError message={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" disabled={pending} onClick={onConfirm}>
            {pending ? "Working…" : confirmLabel}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** Friendly name for where a run came from. */
export function sourceLabel(source: string): string {
  return (
    { playground: "Test chat", hosted_page: "Hosted page", web_widget: "Website widget", api: "API" } as Record<string, string>
  )[source] ?? source.replace(/_/g, " ");
}
