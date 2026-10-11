"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { CheckCircle2, Plus, XCircle } from "lucide-react";
import { Badge, Button, Card, Dialog, Field, FormError, Input, Loading, Notice, PageHeader, Select, Table, Toggle } from "@/components/ui";
import { ADMIN_API, QueryError, errorText, useIsSuperAdmin } from "@/components/admin/shared";
import { MODEL_TIERS, type AiModel, type ModelsResponse } from "@/components/admin/types";
import { api } from "@/lib/api";
import { formatNumber, formatUsd } from "@/lib/format";

const PROVIDERS = ["openai", "anthropic", "google"] as const;
const KEY = ["admin", "models"];

export default function AdminModelsPage() {
  const qc = useQueryClient();
  const isSuper = useIsSuperAdmin();
  const [editing, setEditing] = useState<AiModel | null>(null);
  const [adding, setAdding] = useState(false);

  const models = useQuery({ queryKey: KEY, queryFn: () => api<ModelsResponse>(`${ADMIN_API}/models`) });
  const update = useMutation({
    mutationFn: ({ id, ...body }: { id: string } & Record<string, unknown>) => api(`${ADMIN_API}/models/${id}`, { method: "PATCH", body: JSON.stringify(body) }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });

  if (models.error) return <QueryError error={models.error} />;
  if (!models.data) return <Loading />;
  const { data: rows, platformKeys, mockMode } = models.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Models"
        description="The model catalog organizations can choose from, and what we charge per million tokens."
        actions={
          isSuper && (
            <Button onClick={() => setAdding(true)}>
              <Plus className="size-4" /> Add model
            </Button>
          )
        }
      />

      {mockMode && <Notice tone="warning">Mock mode is on (MOCK_LLM=true). Agents return canned replies and no provider is called.</Notice>}

      <div className="grid gap-4 sm:grid-cols-3">
        {PROVIDERS.map((p) => (
          <Card key={p} className="flex items-center justify-between p-4">
            <div>
              <p className="text-sm font-medium capitalize">{p}</p>
              <p className="text-xs text-[var(--muted)]">Platform API key</p>
            </div>
            {platformKeys[p] ? (
              <span className="inline-flex items-center gap-1 text-sm text-green-700 dark:text-green-400">
                <CheckCircle2 className="size-4" /> Configured
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-sm text-[var(--muted)]">
                <XCircle className="size-4" /> Missing
              </span>
            )}
          </Card>
        ))}
      </div>

      <FormError message={errorText(update.error)} />

      <Table>
        <thead>
          <tr>
            <th>Model</th>
            <th>Provider</th>
            <th>Kind</th>
            <th>Tier</th>
            <th className="text-right">Context</th>
            <th className="text-right">Input $/M</th>
            <th className="text-right">Output $/M</th>
            <th>Enabled</th>
            <th className="text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id}>
              <td>
                <span className="font-medium">{m.displayName}</span>
                {m.isDefault && (
                  <Badge tone="green" className="ml-2">
                    default
                  </Badge>
                )}
                <p className="font-mono text-xs text-[var(--muted)]">{m.modelKey}</p>
              </td>
              <td className="capitalize">{m.provider}</td>
              <td>{m.kind}</td>
              <td>{m.tier}</td>
              <td className="text-right tabular-nums">{formatNumber(m.contextWindow)}</td>
              <td className="text-right tabular-nums">{formatUsd(m.inputPricePerMtokUsd)}</td>
              <td className="text-right tabular-nums">{formatUsd(m.outputPricePerMtokUsd)}</td>
              <td>
                <Toggle
                  checked={m.isEnabled}
                  disabled={!isSuper || update.isPending}
                  onChange={(v) => update.mutate({ id: m.id, isEnabled: v })}
                  label={m.isEnabled ? "On" : "Off"}
                />
              </td>
              <td className="text-right whitespace-nowrap">
                {isSuper && (
                  <div className="flex justify-end gap-2">
                    {m.kind === "chat" && !m.isDefault && (
                      <Button size="sm" variant="secondary" disabled={update.isPending || !m.isEnabled} onClick={() => update.mutate({ id: m.id, isDefault: true })}>
                        Set default
                      </Button>
                    )}
                    <Button size="sm" variant="secondary" onClick={() => setEditing(m)}>
                      Edit prices
                    </Button>
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </Table>

      {editing && <PriceDialog model={editing} onClose={() => setEditing(null)} />}
      <AddModelDialog open={adding} onClose={() => setAdding(false)} />
    </div>
  );
}

function PriceDialog({ model, onClose }: { model: AiModel; onClose: () => void }) {
  const qc = useQueryClient();
  const [input, setInput] = useState(String(Number(model.inputPricePerMtokUsd)));
  const [output, setOutput] = useState(String(Number(model.outputPricePerMtokUsd)));
  const save = useMutation({
    mutationFn: () =>
      api(`${ADMIN_API}/models/${model.id}`, {
        method: "PATCH",
        body: JSON.stringify({ inputPricePerMtokUsd: Number(input), outputPricePerMtokUsd: Number(output) }),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: KEY });
      onClose();
    },
  });

  return (
    <Dialog open onClose={onClose} title={`Prices: ${model.displayName}`}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate();
        }}
      >
        <Field label="Input price (USD per million tokens)" htmlFor="price-in">
          <Input id="price-in" type="number" min={0} step="0.000001" required value={input} onChange={(e) => setInput(e.target.value)} />
        </Field>
        <Field label="Output price (USD per million tokens)" htmlFor="price-out">
          <Input id="price-out" type="number" min={0} step="0.000001" required value={output} onChange={(e) => setOutput(e.target.value)} />
        </Field>
        <FormError message={errorText(save.error)} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.isPending}>
            {save.isPending ? "Saving…" : "Save prices"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const emptyModel = {
  provider: "openai" as AiModel["provider"],
  modelKey: "",
  displayName: "",
  tier: "balanced" as AiModel["tier"],
  kind: "chat" as AiModel["kind"],
  contextWindow: "128000",
  inputPricePerMtokUsd: "",
  outputPricePerMtokUsd: "",
  tools: true,
  vision: false,
  temperature: true,
};

function AddModelDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState(emptyModel);
  const set = <K extends keyof typeof emptyModel>(k: K, v: (typeof emptyModel)[K]) => setF((s) => ({ ...s, [k]: v }));

  const create = useMutation({
    mutationFn: () =>
      api(`${ADMIN_API}/models`, {
        method: "POST",
        body: JSON.stringify({
          provider: f.provider,
          modelKey: f.modelKey.trim(),
          displayName: f.displayName.trim(),
          tier: f.tier,
          kind: f.kind,
          contextWindow: Number(f.contextWindow),
          inputPricePerMtokUsd: Number(f.inputPricePerMtokUsd),
          outputPricePerMtokUsd: Number(f.outputPricePerMtokUsd),
          capabilities: { tools: f.tools, vision: f.vision, temperature: f.temperature },
          isEnabled: true,
        }),
      }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: KEY });
      close();
    },
  });

  function close() {
    setF(emptyModel);
    create.reset();
    onClose();
  }

  return (
    <Dialog open={open} onClose={close} title="Add model" wide>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Provider" htmlFor="m-provider">
            <Select id="m-provider" value={f.provider} onChange={(e) => set("provider", e.target.value as AiModel["provider"])}>
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Kind" htmlFor="m-kind">
            <Select id="m-kind" value={f.kind} onChange={(e) => set("kind", e.target.value as AiModel["kind"])}>
              <option value="chat">chat</option>
              <option value="embedding">embedding</option>
            </Select>
          </Field>
          <Field label="Model key" htmlFor="m-key" hint="The provider's model ID.">
            <Input id="m-key" required maxLength={100} value={f.modelKey} onChange={(e) => set("modelKey", e.target.value)} placeholder="gpt-4.1-mini" />
          </Field>
          <Field label="Display name" htmlFor="m-name">
            <Input id="m-name" required maxLength={100} value={f.displayName} onChange={(e) => set("displayName", e.target.value)} />
          </Field>
          <Field label="Tier" htmlFor="m-tier">
            <Select id="m-tier" value={f.tier} onChange={(e) => set("tier", e.target.value as AiModel["tier"])}>
              {MODEL_TIERS.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Context window (tokens)" htmlFor="m-ctx">
            <Input id="m-ctx" type="number" min={1000} required value={f.contextWindow} onChange={(e) => set("contextWindow", e.target.value)} />
          </Field>
          <Field label="Input price (USD / M tokens)" htmlFor="m-in">
            <Input id="m-in" type="number" min={0} step="0.000001" required value={f.inputPricePerMtokUsd} onChange={(e) => set("inputPricePerMtokUsd", e.target.value)} />
          </Field>
          <Field label="Output price (USD / M tokens)" htmlFor="m-out">
            <Input id="m-out" type="number" min={0} step="0.000001" required value={f.outputPricePerMtokUsd} onChange={(e) => set("outputPricePerMtokUsd", e.target.value)} />
          </Field>
        </div>
        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">Capabilities</legend>
          <div className="flex flex-wrap gap-4 text-sm">
            {(["tools", "vision", "temperature"] as const).map((c) => (
              <label key={c} className="inline-flex items-center gap-1.5">
                <input type="checkbox" checked={f[c]} onChange={(e) => set(c, e.target.checked)} />
                {c === "temperature" ? "Accepts temperature" : c}
              </label>
            ))}
          </div>
        </fieldset>
        <FormError message={errorText(create.error)} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" disabled={create.isPending}>
            {create.isPending ? "Adding…" : "Add model"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
