"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Download, Search, Trash2 } from "lucide-react";
import { Button, Card, Field, FormError, Hint, Input, Notice, Select } from "@/components/ui";
import { useRole } from "@/components/app/use-role";
import { api } from "@/lib/api";

interface PrivacySettings {
  conversationRetentionDays: number;
  retentionOptions: number[];
}

interface EndUserSummary {
  conversations: number;
  messages: number;
  firstAt: string | null;
  lastAt: string | null;
}

/** Retention and end-user data requests (access / erasure) for the organization's chats. */
export default function PrivacySettingsPage() {
  const { role, isAdmin } = useRole();
  return (
    <div className="max-w-2xl space-y-6">
      <Retention canEdit={role === "owner"} />
      {isAdmin && <EndUserRequests />}
    </div>
  );
}

function Retention({ canEdit }: { canEdit: boolean }) {
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ["privacy-settings"], queryFn: () => api<PrivacySettings>("/api/v1/privacy/settings") });
  const save = useMutation({
    mutationFn: (days: number) => api("/api/v1/privacy/settings", { method: "PATCH", body: JSON.stringify({ conversationRetentionDays: days }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["privacy-settings"] }),
  });
  if (!data) return null;
  return (
    <Card className="space-y-4">
      <div>
        <h2 className="font-medium">Conversation history</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          Chats with your agents (from the chat page, widget, API and test chat) are deleted automatically after a period with no new messages. Run logs are kept for
          your plan&apos;s log retention or this period, whichever is shorter.
        </p>
      </div>
      <Field label="Delete conversations after" htmlFor="retention" hint={canEdit ? undefined : "Only the organization owner can change this."}>
        <Select
          id="retention"
          className="w-56"
          value={data.conversationRetentionDays}
          disabled={!canEdit || save.isPending}
          onChange={(e) => save.mutate(Number(e.target.value))}
        >
          {data.retentionOptions.map((d) => (
            <option key={d} value={d}>
              {d === 365 ? "1 year" : `${d} days`} of inactivity
            </option>
          ))}
        </Select>
      </Field>
      <Hint>Deleted conversations also disappear from our backups within 14 days.</Hint>
      <FormError message={save.error ? (save.error as Error).message : null} />
    </Card>
  );
}

function EndUserRequests() {
  const [ref, setRef] = useState("");
  const [summary, setSummary] = useState<EndUserSummary | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const body = () => JSON.stringify({ endUserRef: ref.trim() });

  async function run(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const lookup = (e: React.FormEvent) => {
    e.preventDefault();
    void run(async () => setSummary(await api<EndUserSummary>("/api/v1/privacy/end-users/lookup", { method: "POST", body: body() })));
  };

  const download = () =>
    run(async () => {
      const data = await api<unknown>("/api/v1/privacy/end-users/export", { method: "POST", body: body() });
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = `end-user-export-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    });

  const erase = () => {
    if (!confirm(`Permanently delete ${summary?.conversations ?? 0} conversation(s) for this person? This can't be undone.`)) return;
    void run(async () => {
      const r = await api<{ conversations: number; executions: number }>("/api/v1/privacy/end-users/erase", { method: "POST", body: body() });
      setDone(`Deleted ${r.conversations} conversation(s) and ${r.executions} run log(s).`);
      setSummary(null);
    });
  };

  return (
    <Card className="space-y-4">
      <div>
        <h2 className="font-medium">Requests from your customers</h2>
        <p className="mt-1 text-sm text-[var(--muted)]">
          When someone who chatted with your agent asks for a copy of their data, or for it to be deleted, find their conversations by the user id. For the API that&apos;s the{" "}
          <code>userId</code> you sent. For the widget and chat page it&apos;s the visitor id shown on the conversation in Logs. Visitors can also delete a chat themselves
          from the chat window.
        </p>
      </div>
      <form onSubmit={lookup} className="flex gap-2">
        <Input
          aria-label="User id"
          value={ref}
          onChange={(e) => {
            setRef(e.target.value);
            setSummary(null);
          }}
          placeholder="e.g. customer-123"
          maxLength={200}
        />
        <Button type="submit" variant="secondary" disabled={busy || !ref.trim()}>
          <Search className="size-4" /> Find
        </Button>
      </form>
      {summary && summary.conversations === 0 && <Notice>No conversations found for this user id.</Notice>}
      {summary && summary.conversations > 0 && (
        <div className="space-y-3 rounded-md border border-[var(--border)] p-3 text-sm">
          <p>
            <span className="font-medium">{summary.conversations}</span> conversation(s), <span className="font-medium">{summary.messages}</span> message(s)
            {summary.firstAt && (
              <>
                {" "}
                from {new Date(summary.firstAt).toLocaleDateString()} to {new Date(summary.lastAt ?? summary.firstAt).toLocaleDateString()}
              </>
            )}
            .
          </p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={download} disabled={busy}>
              <Download className="size-4" /> Download a copy
            </Button>
            <Button variant="danger" onClick={erase} disabled={busy}>
              <Trash2 className="size-4" /> Delete everything
            </Button>
          </div>
        </div>
      )}
      {done && <Notice tone="success">{done}</Notice>}
      <FormError message={error} />
    </Card>
  );
}
