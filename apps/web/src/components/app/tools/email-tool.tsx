"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Send } from "lucide-react";
import { Button, Dialog, Field, FormError, Hint, Input, Notice, Textarea } from "@/components/ui";
import { errorMessage } from "@/components/app/misc";
import type { Tool } from "@/components/app/types";
import { api } from "@/lib/api";
import { suggestName } from "./tool-form";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Create/edit a "Send email" tool: fixed recipients the agent can notify (never chosen by the agent). */
export function EmailToolFormDialog({ open, tool, onClose, onSaved }: { open: boolean; tool: Tool | null; onClose: () => void; onSaved: (t: Tool) => void }) {
  return (
    <Dialog open={open} onClose={onClose} title={tool ? `Edit ${tool.name}` : "New email tool"} wide>
      {open && <EmailToolForm key={tool?.id ?? "new"} tool={tool} onCancel={onClose} onSaved={onSaved} />}
    </Dialog>
  );
}

function EmailToolForm({ tool, onCancel, onSaved }: { tool: Tool | null; onCancel: () => void; onSaved: (t: Tool) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState(tool?.name ?? "notify_team");
  const [description, setDescription] = useState(
    tool?.description ?? "Email the team when a visitor is a qualified lead or asks for a callback. Include their name, contact details and what they need.",
  );
  const [recipients, setRecipients] = useState((tool?.config.recipients ?? []).join("\n"));
  const [subjectPrefix, setSubjectPrefix] = useState(tool?.config.subjectPrefix ?? "[AI agent]");
  const [localError, setLocalError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: object) =>
      tool
        ? api<Tool>(`/api/v1/tools/${tool.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : api<Tool>("/api/v1/tools", { method: "POST", body: JSON.stringify({ ...body, providerKey: "send_email" }) }),
    onSuccess: async (saved) => {
      await qc.invalidateQueries({ queryKey: ["tools"] });
      onSaved({ ...saved, credentialName: null });
    },
  });

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);
    const list = recipients
      .split(/[\n,;]/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length === 0 || list.length > 5) return setLocalError("Add between 1 and 5 email addresses.");
    const bad = list.find((r) => !EMAIL_RE.test(r));
    if (bad) return setLocalError(`"${bad}" isn't a valid email address.`);
    save.mutate({ name, description, config: { recipients: list, subjectPrefix } });
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <Notice>The agent can only email the addresses you list here. It can&apos;t send email to customers or any address it picks itself.</Notice>
      <Field label="Function name" htmlFor="et-name" hint="Lowercase letters, numbers and underscores.">
        <Input id="et-name" value={name} onChange={(e) => setName(suggestName(e.target.value) || e.target.value)} className="font-mono" required />
      </Field>
      <Field label="When should the agent send an email?" htmlFor="et-desc">
        <Textarea id="et-desc" value={description} onChange={(e) => setDescription(e.target.value)} className="min-h-20" required />
      </Field>
      <Field label="Recipients" htmlFor="et-to">
        <Textarea id="et-to" value={recipients} onChange={(e) => setRecipients(e.target.value)} className="min-h-16 font-mono text-xs" placeholder="sales@yourcompany.com" />
        <Hint>One per line, up to 5.</Hint>
      </Field>
      <Field label="Subject prefix" htmlFor="et-prefix">
        <Input id="et-prefix" value={subjectPrefix} maxLength={60} onChange={(e) => setSubjectPrefix(e.target.value)} />
      </Field>
      <FormError message={localError ?? errorMessage(save.error)} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}

export function EmailToolTest({ tool }: { tool: Tool }) {
  const run = useMutation({
    mutationFn: () => api<{ output: { sent?: boolean; error?: string } }>(`/api/v1/tools/${tool.id}/test`, { method: "POST", body: JSON.stringify({ input: {} }) }),
  });
  return (
    <div className="space-y-4">
      <p className="text-sm text-[var(--muted)]">Sends a test email to {(tool.config.recipients ?? []).join(", ")}.</p>
      <Button onClick={() => run.mutate()} disabled={run.isPending}>
        <Send className="size-4" /> {run.isPending ? "Sending…" : "Send test email"}
      </Button>
      {run.data && (run.data.output.sent ? <Notice tone="success">Test email sent.</Notice> : <FormError message={run.data.output.error ?? "Not sent."} />)}
      <FormError message={errorMessage(run.error)} />
    </div>
  );
}
