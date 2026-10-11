"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Button, Card, FormError, Input, Loading, Notice } from "@/components/ui";
import { ConfirmDialog, errorMessage } from "@/components/app/misc";
import { useRole } from "@/components/app/use-role";
import { api } from "@/lib/api";
import { cn } from "@/lib/cn";
import { timeAgo } from "@/lib/format";

type Provider = "openai" | "anthropic" | "google";
type Mode = "platform" | "byok";

interface ProviderSetting {
  provider: Provider;
  mode: Mode;
  key: { last4: string | null; updatedAt: string; status: string } | null;
}

const providerInfo: Record<Provider, { name: string; models: string; keyUrl: string; placeholder: string }> = {
  openai: { name: "OpenAI", models: "GPT models", keyUrl: "https://platform.openai.com/api-keys", placeholder: "sk-…" },
  anthropic: { name: "Anthropic", models: "Claude models", keyUrl: "https://console.anthropic.com/settings/keys", placeholder: "sk-ant-…" },
  google: { name: "Google", models: "Gemini models", keyUrl: "https://aistudio.google.com/app/apikey", placeholder: "AIza…" },
};

export default function AiSettingsPage() {
  const { isAdmin } = useRole();
  const { data, isLoading, error } = useQuery({ queryKey: ["ai-settings"], queryFn: () => api<{ providers: ProviderSetting[] }>("/api/v1/ai-settings") });

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2">
        <Card className="p-4">
          <h2 className="text-sm font-medium">Platform credits</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">AI usage included with your plan. Nothing to set up — this is the default.</p>
        </Card>
        <Card className="p-4">
          <h2 className="text-sm font-medium">Your own key</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            Use your own account with the AI provider. They bill you directly, and it doesn&apos;t use your credits. Your plan&apos;s message limits still apply.
          </p>
        </Card>
      </div>
      {!isAdmin && <Notice>Only admins can change AI provider settings.</Notice>}
      <FormError message={errorMessage(error)} />
      {isLoading ? <Loading /> : data?.providers.map((p) => <ProviderCard key={p.provider} setting={p} canEdit={isAdmin} />)}
    </div>
  );
}

function ProviderCard({ setting, canEdit }: { setting: ProviderSetting; canEdit: boolean }) {
  const qc = useQueryClient();
  const info = providerInfo[setting.provider];
  const [editingKey, setEditingKey] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ["ai-settings"] });

  const saveKey = useMutation({
    mutationFn: () => api(`/api/v1/ai-settings/${setting.provider}/key`, { method: "PUT", body: JSON.stringify({ apiKey: apiKey.trim() }) }),
    onSuccess: async () => {
      setApiKey("");
      setEditingKey(false);
      await refresh();
    },
  });
  const removeKey = useMutation({
    mutationFn: () => api(`/api/v1/ai-settings/${setting.provider}/key`, { method: "DELETE" }),
    onSuccess: async () => {
      setConfirmRemove(false);
      await refresh();
    },
  });
  const setMode = useMutation({
    mutationFn: (mode: Mode) => api(`/api/v1/ai-settings/${setting.provider}/mode`, { method: "PUT", body: JSON.stringify({ mode }) }),
    onSuccess: refresh,
  });

  const showKeyForm = canEdit && (editingKey || !setting.key);

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-medium">{info.name}</h2>
          <p className="text-sm text-[var(--muted)]">{info.models}</p>
        </div>
        <Badge tone={setting.mode === "byok" ? "green" : "blue"}>{setting.mode === "byok" ? "Using your own key" : "Using platform credits"}</Badge>
      </div>

      <div className="mt-4" role="radiogroup" aria-label={`${info.name} billing`}>
        <div className="inline-flex rounded-md border border-[var(--border)] p-0.5">
          {(["platform", "byok"] as const).map((m) => (
            <button
              key={m}
              role="radio"
              aria-checked={setting.mode === m}
              disabled={!canEdit || setMode.isPending || (m === "byok" && !setting.key)}
              title={m === "byok" && !setting.key ? "Add your key first" : undefined}
              onClick={() => setting.mode !== m && setMode.mutate(m)}
              className={cn(
                "rounded px-3 py-1.5 text-sm disabled:cursor-not-allowed",
                setting.mode === m ? "bg-brand-600 text-white" : "text-[var(--muted)] hover:text-[var(--foreground)] disabled:opacity-50",
              )}
            >
              {m === "platform" ? "Platform credits" : "Your own key"}
            </button>
          ))}
        </div>
      </div>
      <div className="mt-2">
        <FormError message={errorMessage(setMode.error)} />
      </div>

      <div className="mt-4 border-t border-[var(--border)] pt-4">
        {setting.key && !editingKey && (
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              Key ending in <span className="font-mono">{setting.key.last4}</span>
              <span className="text-[var(--muted)]"> · saved {timeAgo(setting.key.updatedAt)}</span>
              {setting.key.status !== "active" && (
                <Badge tone="red" className="ml-2">
                  {setting.key.status}
                </Badge>
              )}
            </span>
            {canEdit && (
              <span className="flex gap-2">
                <Button size="sm" variant="secondary" onClick={() => setEditingKey(true)}>
                  Replace key
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(true)}>
                  Remove
                </Button>
              </span>
            )}
          </div>
        )}
        {!setting.key && !canEdit && <p className="text-sm text-[var(--muted)]">No key added.</p>}
        {showKeyForm && (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              saveKey.mutate();
            }}
          >
            <label htmlFor={`key-${setting.provider}`} className="block text-sm font-medium">
              {setting.key ? "New API key" : "Add your API key"}
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id={`key-${setting.provider}`}
                type="password"
                autoComplete="off"
                required
                minLength={10}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={info.placeholder}
                className="font-mono"
              />
              <Button type="submit" disabled={saveKey.isPending || apiKey.trim().length < 10}>
                {saveKey.isPending ? "Checking…" : "Check and save"}
              </Button>
              {editingKey && (
                <Button type="button" variant="ghost" onClick={() => setEditingKey(false)}>
                  Cancel
                </Button>
              )}
            </div>
            <p className="text-xs text-[var(--muted)]">
              We check the key with {info.name} before saving and store it encrypted. Get one from{" "}
              <a href={info.keyUrl} target="_blank" rel="noreferrer" className="text-brand-600 hover:underline">
                your {info.name} account
              </a>
              .
            </p>
            <FormError message={errorMessage(saveKey.error)} />
          </form>
        )}
      </div>

      <ConfirmDialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title={`Remove ${info.name} key?`}
        message={`${info.name} models will switch back to platform credits.`}
        confirmLabel="Remove key"
        pending={removeKey.isPending}
        error={errorMessage(removeKey.error)}
        onConfirm={() => removeKey.mutate()}
      />
    </Card>
  );
}
