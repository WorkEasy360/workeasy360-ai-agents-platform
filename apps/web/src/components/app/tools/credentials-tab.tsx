"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button, Dialog, EmptyState, Field, FormError, Input, Loading, Notice, Select, Table } from "@/components/ui";
import { ConfirmDialog, errorMessage } from "@/components/app/misc";
import type { Credential } from "@/components/app/types";
import { useRole } from "@/components/app/use-role";
import { api } from "@/lib/api";
import { formatDate } from "@/lib/format";

const authTypes: Record<Credential["authType"], { label: string; secretLabel: string; hint: string }> = {
  bearer: { label: "Bearer token", secretLabel: "Token", hint: "Sent as “Authorization: Bearer …”. Most modern APIs use this." },
  api_key: { label: "API key in a header", secretLabel: "API key", hint: "Sent in the header you name below, e.g. X-API-Key." },
  basic: { label: "Username and password", secretLabel: "username:password", hint: "Enter as username:password. Sent as HTTP Basic authentication." },
  header: { label: "Custom header", secretLabel: "Header value", hint: "Any header the API expects, with its value kept secret." },
};

const needsHeader = (t: Credential["authType"]) => t === "api_key" || t === "header";

export function CredentialsTab() {
  const { isAdmin } = useRole();
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["credentials"], queryFn: () => api<{ data: Credential[] }>("/api/v1/credentials") });
  const creds = data?.data ?? [];

  // undefined = closed, null = adding, Credential = rotating.
  const [editing, setEditing] = useState<Credential | null | undefined>(undefined);
  const [deleting, setDeleting] = useState<Credential | null>(null);

  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/credentials/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      setDeleting(null);
      await Promise.all([qc.invalidateQueries({ queryKey: ["credentials"] }), qc.invalidateQueries({ queryKey: ["tools"] })]);
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-[var(--muted)]">Passwords and keys your tools use to sign in to other systems. They&apos;re stored encrypted and never shown again after saving.</p>
        {isAdmin && (
          <Button onClick={() => setEditing(null)} className="shrink-0">
            <Plus className="size-4" /> Add credential
          </Button>
        )}
      </div>
      {!isAdmin && <Notice>Only admins can add or change credentials. You can still choose existing ones when building a tool.</Notice>}

      <FormError message={errorMessage(error)} />
      {isLoading ? (
        <Loading />
      ) : creds.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No credentials yet"
          description="If the API you're connecting to needs a key or password, add it here and pick it when creating a tool."
          action={isAdmin ? <Button onClick={() => setEditing(null)}>Add a credential</Button> : undefined}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Secret</th>
              <th>Added</th>
              {isAdmin && (
                <th>
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {creds.map((c) => (
              <tr key={c.id}>
                <td className="font-medium">{c.name}</td>
                <td className="whitespace-nowrap">
                  {authTypes[c.authType]?.label ?? c.authType}
                  {c.metadata?.headerName && <span className="ml-1 font-mono text-xs text-[var(--muted)]">({c.metadata.headerName})</span>}
                </td>
                <td className="font-mono text-xs whitespace-nowrap">{c.last4 ? `••••${c.last4}` : "••••••••"}</td>
                <td className="whitespace-nowrap text-[var(--muted)]">{formatDate(c.createdAt)}</td>
                {isAdmin && (
                  <td className="whitespace-nowrap text-right">
                    <Button size="sm" variant="ghost" onClick={() => setEditing(c)}>
                      <RefreshCw className="size-3.5" /> Update
                    </Button>
                    <Button size="sm" variant="ghost" aria-label={`Delete ${c.name}`} onClick={() => setDeleting(c)}>
                      <Trash2 className="size-3.5" />
                    </Button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      )}

      <Dialog open={editing !== undefined} onClose={() => setEditing(undefined)} title={editing ? `Update ${editing.name}` : "Add credential"}>
        {editing !== undefined && <CredentialForm key={editing?.id ?? "new"} credential={editing} onDone={() => setEditing(undefined)} />}
      </Dialog>
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete credential?"
        message={
          <>
            Tools using <strong>{deleting?.name}</strong> will be switched to &ldquo;No authentication&rdquo; and will probably stop working until you pick another credential.
          </>
        }
        pending={remove.isPending}
        error={errorMessage(remove.error)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  );
}

function CredentialForm({ credential, onDone }: { credential: Credential | null; onDone: () => void }) {
  const qc = useQueryClient();
  const [authType, setAuthType] = useState<Credential["authType"]>(credential?.authType ?? "bearer");
  const save = useMutation({
    mutationFn: (body: Record<string, string>) =>
      credential
        ? api(`/api/v1/credentials/${credential.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : api("/api/v1/credentials", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: async () => {
      await Promise.all([qc.invalidateQueries({ queryKey: ["credentials"] }), qc.invalidateQueries({ queryKey: ["tools"] })]);
      onDone();
    },
  });

  return (
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const body: Record<string, string> = { name: String(f.get("name")).trim(), authType };
        const secret = String(f.get("secret") ?? "");
        if (secret) body.secret = secret;
        if (needsHeader(authType)) body.headerName = String(f.get("headerName") ?? "").trim();
        save.mutate(body);
      }}
    >
      <Field label="Name" htmlFor="c-name" hint="So you can recognise it, e.g. “Shopify store”.">
        <Input id="c-name" name="name" required maxLength={80} defaultValue={credential?.name} />
      </Field>
      <Field label="How the API signs in" htmlFor="c-type" hint={authTypes[authType].hint}>
        <Select id="c-type" value={authType} onChange={(e) => setAuthType(e.target.value as Credential["authType"])}>
          {Object.entries(authTypes).map(([k, v]) => (
            <option key={k} value={k}>
              {v.label}
            </option>
          ))}
        </Select>
      </Field>
      {needsHeader(authType) && (
        <Field label="Header name" htmlFor="c-header">
          <Input
            id="c-header"
            name="headerName"
            required
            pattern="[A-Za-z0-9-]{1,100}"
            title="Letters, numbers and dashes"
            defaultValue={credential?.metadata?.headerName ?? (authType === "api_key" ? "X-API-Key" : "")}
            className="font-mono"
          />
        </Field>
      )}
      <Field
        label={authTypes[authType].secretLabel}
        htmlFor="c-secret"
        hint={credential ? `${credential.last4 ? `Currently ends in ${credential.last4}. ` : ""}Leave blank to keep the current value.` : "Stored encrypted. You won't be able to see it again."}
      >
        <Input id="c-secret" name="secret" type="password" autoComplete="off" required={!credential} maxLength={4000} />
      </Field>
      <FormError message={errorMessage(save.error)} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : credential ? "Save" : "Add credential"}
        </Button>
      </div>
    </form>
  );
}
