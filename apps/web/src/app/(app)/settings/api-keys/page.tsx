"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus } from "lucide-react";
import { Button, Dialog, EmptyState, Field, FormError, Input, Loading, Notice, Select, Table } from "@/components/ui";
import { ConfirmDialog, CopyBox, errorMessage } from "@/components/app/misc";
import { useRole } from "@/components/app/use-role";
import { WebhookSecretCard } from "@/components/app/webhook-secret";
import { api } from "@/lib/api";
import { formatDate, timeAgo } from "@/lib/format";

interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

export default function ApiKeysPage() {
  const { role, isAdmin } = useRole();
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({
    queryKey: ["api-keys"],
    enabled: isAdmin,
    queryFn: () => api<{ data: ApiKey[] }>("/api/v1/api-keys"),
  });
  const keys = data?.data ?? [];
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKey | null>(null);

  const revoke = useMutation({
    mutationFn: (id: string) => api(`/api/v1/api-keys/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      setRevoking(null);
      await qc.invalidateQueries({ queryKey: ["api-keys"] });
    },
  });

  if (!role) return <Loading />;
  if (!isAdmin) return <Notice>Only admins can see and manage API keys.</Notice>;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-[var(--muted)]">API keys let your own software send messages to your agents. Keep them secret, like a password.</p>
        <Button onClick={() => setCreating(true)} className="shrink-0">
          <Plus className="size-4" /> Create API key
        </Button>
      </div>
      <FormError message={errorMessage(error)} />
      {isLoading ? (
        <Loading />
      ) : keys.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No API keys"
          description="Create a key if a developer wants to connect your agents to your website, app or other systems."
          action={<Button onClick={() => setCreating(true)}>Create API key</Button>}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Key</th>
              <th>Last used</th>
              <th>Expires</th>
              <th>Created</th>
              <th>
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => {
              const expired = k.expiresAt && new Date(k.expiresAt) < new Date();
              return (
                <tr key={k.id}>
                  <td className="font-medium">{k.name}</td>
                  <td className="font-mono text-xs whitespace-nowrap">{k.prefix}…</td>
                  <td className="whitespace-nowrap text-[var(--muted)]">{k.lastUsedAt ? timeAgo(k.lastUsedAt) : "Never"}</td>
                  <td className="whitespace-nowrap">
                    {k.expiresAt ? <span className={expired ? "text-red-600 dark:text-red-400" : undefined}>{expired ? "Expired " : ""}{formatDate(k.expiresAt)}</span> : "Never"}
                  </td>
                  <td className="whitespace-nowrap text-[var(--muted)]">{formatDate(k.createdAt)}</td>
                  <td className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => setRevoking(k)}>
                      Revoke
                    </Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </Table>
      )}

      <WebhookSecretCard />
      <Dialog open={creating} onClose={() => setCreating(false)} title="Create API key">
        {creating && <CreateKeyForm onDone={() => setCreating(false)} />}
      </Dialog>
      <ConfirmDialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title="Revoke API key?"
        message={
          <>
            Anything using <strong>{revoking?.name}</strong> will stop working immediately. This can&apos;t be undone.
          </>
        }
        confirmLabel="Revoke"
        pending={revoke.isPending}
        error={errorMessage(revoke.error)}
        onConfirm={() => revoking && revoke.mutate(revoking.id)}
      />
    </div>
  );
}

function CreateKeyForm({ onDone }: { onDone: () => void }) {
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: (body: { name: string; expiresInDays?: number }) =>
      api<ApiKey & { secret: string }>("/api/v1/api-keys", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["api-keys"] }),
  });

  if (create.data) {
    return (
      <div className="space-y-4">
        <Notice tone="warning">Copy this key now. For your security it won&apos;t be shown again — if you lose it, create a new one.</Notice>
        <CopyBox value={create.data.secret} />
        <div className="flex justify-end">
          <Button onClick={onDone}>I&apos;ve copied it</Button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const days = Number(f.get("expires"));
        create.mutate({ name: String(f.get("name")).trim(), ...(days ? { expiresInDays: days } : {}) });
      }}
    >
      <Field label="Name" htmlFor="k-name" hint="Where it will be used, e.g. “Website backend”.">
        <Input id="k-name" name="name" required maxLength={80} autoFocus />
      </Field>
      <Field label="Expires" htmlFor="k-exp">
        <Select id="k-exp" name="expires" defaultValue="">
          <option value="">Never</option>
          <option value="30">In 30 days</option>
          <option value="90">In 90 days</option>
          <option value="365">In 1 year</option>
        </Select>
      </Field>
      <FormError message={errorMessage(create.error)} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={create.isPending}>
          {create.isPending ? "Creating…" : "Create key"}
        </Button>
      </div>
    </form>
  );
}
