"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { Button, Dialog, Field, FormError, Hint, Input, Label, Select, Textarea } from "@/components/ui";
import { errorMessage } from "@/components/app/misc";
import type { Credential, HttpConfig, Tool, ToolParam } from "@/components/app/types";
import { api } from "@/lib/api";

const NAME_RE = /^[a-z][a-z0-9_]{1,63}$/;
const PARAM_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/;

/** "Look up order status" → "look_up_order_status" */
export function suggestName(display: string): string {
  let s = display
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  if (s && !/^[a-z]/.test(s)) s = `tool_${s}`.slice(0, 64);
  return s;
}

function humanize(name: string) {
  const s = name.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type Header = { key: string; value: string };

export function ToolFormDialog({ open, tool, onClose, onSaved }: { open: boolean; tool: Tool | null; onClose: () => void; onSaved: (t: Tool) => void }) {
  return (
    <Dialog open={open} onClose={onClose} title={tool ? `Edit ${tool.name}` : "New API tool"} wide>
      {/* Remount on open so fields reset to the selected tool. */}
      {open && <ToolForm key={tool?.id ?? "new"} tool={tool} onCancel={onClose} onSaved={onSaved} />}
    </Dialog>
  );
}

function ToolForm({ tool, onCancel, onSaved }: { tool: Tool | null; onCancel: () => void; onSaved: (t: Tool) => void }) {
  const qc = useQueryClient();
  const credentials = useQuery({ queryKey: ["credentials"], queryFn: () => api<{ data: Credential[] }>("/api/v1/credentials") });

  const [displayName, setDisplayName] = useState(tool ? humanize(tool.name) : "");
  const [name, setName] = useState(tool?.name ?? "");
  const [nameTouched, setNameTouched] = useState(!!tool);
  const [description, setDescription] = useState(tool?.description ?? "");
  const [method, setMethod] = useState<HttpConfig["method"]>(tool?.config.method ?? "GET");
  const [url, setUrl] = useState(tool?.config.url ?? "");
  const [params, setParams] = useState<ToolParam[]>(tool?.config.params ?? []);
  const [headers, setHeaders] = useState<Header[]>(Object.entries(tool?.config.headers ?? {}).map(([key, value]) => ({ key, value })));
  const [credentialId, setCredentialId] = useState(tool?.credentialId ?? "");
  const [timeoutSec, setTimeoutSec] = useState(String((tool?.config.timeoutMs ?? 15_000) / 1000));
  const [localError, setLocalError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: object) =>
      tool
        ? api<Tool>(`/api/v1/tools/${tool.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : api<Tool>("/api/v1/tools", { method: "POST", body: JSON.stringify(body) }),
    onSuccess: async (saved) => {
      await qc.invalidateQueries({ queryKey: ["tools"] });
      onSaved({ ...saved, credentialName: credentials.data?.data.find((c) => c.id === saved.credentialId)?.name ?? null });
    },
  });

  function updateParam(i: number, patch: Partial<ToolParam>) {
    setParams((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  }

  // Placeholders in the URL that don't have a matching parameter yet.
  const placeholders = [...url.matchAll(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g)].map((m) => m[1]!);
  const missing = placeholders.filter((p) => !params.some((x) => x.name === p));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setLocalError(null);
    if (!NAME_RE.test(name)) return setLocalError("Function name must start with a letter and use only lowercase letters, numbers and underscores (2–64 characters).");
    const badParam = params.find((p) => !PARAM_RE.test(p.name));
    if (badParam) return setLocalError(`Parameter "${badParam.name || "(empty)"}" needs a name using letters, numbers and underscores.`);
    const names = params.map((p) => p.name);
    if (new Set(names).size !== names.length) return setLocalError("Each parameter needs a different name.");
    const timeoutMs = Math.round(Number(timeoutSec) * 1000);
    if (!(timeoutMs >= 1000 && timeoutMs <= 30_000)) return setLocalError("Timeout must be between 1 and 30 seconds.");

    const config: HttpConfig = {
      method,
      url: url.trim(),
      headers: Object.fromEntries(headers.filter((h) => h.key.trim()).map((h) => [h.key.trim(), h.value])),
      params,
      timeoutMs,
    };
    save.mutate({ name, description: description.trim(), config, credentialId: credentialId || null });
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Tool name" htmlFor="t-display" hint="A friendly name for your team.">
          <Input
            id="t-display"
            value={displayName}
            onChange={(e) => {
              setDisplayName(e.target.value);
              if (!nameTouched) setName(suggestName(e.target.value));
            }}
            placeholder="e.g. Look up order status"
            required={!tool}
          />
        </Field>
        <Field label="Function name" htmlFor="t-name" hint="What the agent calls it. Lowercase letters, numbers and underscores.">
          <Input
            id="t-name"
            value={name}
            onChange={(e) => {
              setNameTouched(true);
              setName(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_"));
            }}
            className="font-mono"
            placeholder="look_up_order_status"
            required
            maxLength={64}
          />
        </Field>
      </div>

      <Field label="When should the agent use this?" htmlFor="t-desc" hint="Be specific — the agent reads this to decide when to call the tool and what it returns.">
        <Textarea
          id="t-desc"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          required
          minLength={10}
          maxLength={1000}
          className="min-h-20"
          placeholder="Use when a customer asks where their order is. Returns the order status and expected delivery date."
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-[8rem_1fr]">
        <Field label="Method" htmlFor="t-method">
          <Select id="t-method" value={method} onChange={(e) => setMethod(e.target.value as HttpConfig["method"])}>
            {(["GET", "POST", "PUT", "PATCH", "DELETE"] as const).map((m) => (
              <option key={m}>{m}</option>
            ))}
          </Select>
        </Field>
        <Field
          label="URL"
          htmlFor="t-url"
          hint={
            <>
              Put parameters in curly braces to fill them into the address, e.g. <code>https://api.example.com/orders/{"{order_id}"}</code>. Other parameters are sent{" "}
              {method === "GET" || method === "DELETE" ? "in the query string" : "as a JSON body"}.
            </>
          }
        >
          <Input id="t-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} required placeholder="https://api.example.com/orders/{order_id}" />
        </Field>
      </div>

      <div>
        <Label>Parameters</Label>
        <Hint>Information the agent fills in when it uses the tool.</Hint>
        <div className="mt-2 space-y-2">
          {params.map((p, i) => (
            <div key={i} className="grid gap-2 rounded-md border border-[var(--border)] p-3 sm:grid-cols-[1fr_7rem_auto_auto] sm:items-center">
              <Input aria-label="Parameter name" value={p.name} onChange={(e) => updateParam(i, { name: e.target.value.replace(/[^a-zA-Z0-9_]/g, "_") })} placeholder="order_id" className="font-mono" />
              <Select aria-label="Type" value={p.type} onChange={(e) => updateParam(i, { type: e.target.value as ToolParam["type"] })}>
                <option value="string">Text</option>
                <option value="number">Number</option>
                <option value="boolean">Yes/no</option>
              </Select>
              <label className="flex items-center gap-1.5 text-sm whitespace-nowrap">
                <input type="checkbox" checked={p.required} onChange={(e) => updateParam(i, { required: e.target.checked })} /> Required
              </label>
              <Button type="button" size="sm" variant="ghost" aria-label="Remove parameter" onClick={() => setParams((ps) => ps.filter((_, j) => j !== i))}>
                <Trash2 className="size-3.5" />
              </Button>
              <Input
                aria-label="Parameter description"
                value={p.description}
                maxLength={500}
                onChange={(e) => updateParam(i, { description: e.target.value })}
                placeholder="What is this? e.g. The order number, like 10023"
                className="sm:col-span-4"
              />
            </div>
          ))}
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="secondary" onClick={() => setParams((ps) => [...ps, { name: "", type: "string", description: "", required: false }])}>
              <Plus className="size-3.5" /> Add parameter
            </Button>
            {missing.map((m) => (
              <Button
                key={m}
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setParams((ps) => [...ps, { name: m, type: "string", description: "", required: true }])}
              >
                <Plus className="size-3.5" /> Add &ldquo;{m}&rdquo; from URL
              </Button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Credential" htmlFor="t-cred" hint="How to sign in to the API. Admins add these in the Credentials tab.">
          <Select id="t-cred" value={credentialId} onChange={(e) => setCredentialId(e.target.value)}>
            <option value="">No authentication</option>
            {credentials.data?.data.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.last4 ? ` (…${c.last4})` : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Timeout (seconds)" htmlFor="t-timeout" hint="Give up if the API takes longer than this. 1–30.">
          <Input id="t-timeout" type="number" min={1} max={30} step={1} value={timeoutSec} onChange={(e) => setTimeoutSec(e.target.value)} />
        </Field>
      </div>

      <details className="rounded-md border border-[var(--border)] p-3">
        <summary className="cursor-pointer text-sm font-medium">Extra headers (optional)</summary>
        <div className="mt-3 space-y-2">
          {headers.map((h, i) => (
            <div key={i} className="flex gap-2">
              <Input aria-label="Header name" value={h.key} placeholder="Header name" onChange={(e) => setHeaders((hs) => hs.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))} />
              <Input aria-label="Header value" value={h.value} placeholder="Value" onChange={(e) => setHeaders((hs) => hs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
              <Button type="button" size="sm" variant="ghost" aria-label="Remove header" onClick={() => setHeaders((hs) => hs.filter((_, j) => j !== i))}>
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
          <Button type="button" size="sm" variant="secondary" onClick={() => setHeaders((hs) => [...hs, { key: "", value: "" }])}>
            <Plus className="size-3.5" /> Add header
          </Button>
          <Hint>Don&apos;t put passwords or keys here — use a credential so they stay hidden.</Hint>
        </div>
      </details>

      <FormError message={localError ?? errorMessage(save.error)} />
      <div className="flex justify-end gap-2">
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : tool ? "Save changes" : "Create and test"}
        </Button>
      </div>
    </form>
  );
}
