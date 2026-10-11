"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Bot, Copy, Plus, Sparkles, Trash2 } from "lucide-react";
import { Badge, Button, Dialog, EmptyState, Field, FormError, Hint, Input, Loading, Notice, PageHeader, Table, Tabs, Textarea } from "@/components/ui";
import { DeleteAgentDialog } from "@/components/app/delete-agent";
import { useRole } from "@/components/app/use-role";
import { api, ApiError } from "@/lib/api";
import type { AgentListItem } from "@/lib/agents";
import { formatPercent, timeAgo } from "@/lib/format";
import { cn } from "@/lib/cn";

interface Template {
  key: string;
  name: string;
  description: string;
  /** Saved by this organization (vs. built-in). */
  custom: boolean;
  id?: string;
}

export default function AgentsPage() {
  const [creating, setCreating] = useState(false);
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["agents"], queryFn: () => api<{ data: AgentListItem[] }>("/api/v1/agents") });
  const duplicate = useMutation({
    mutationFn: (id: string) => api(`/api/v1/agents/${id}/duplicate`, { method: "POST" }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agents"] }),
  });

  const agents = data?.data ?? [];
  const { isAdmin } = useRole();
  const [deleting, setDeleting] = useState<AgentListItem | null>(null);

  return (
    <div className="mx-auto max-w-6xl">
      <PageHeader
        title="Agents"
        description="Each agent has its own instructions, knowledge and tools."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus className="size-4" /> New agent
          </Button>
        }
      />
      {duplicate.error && <FormError message={(duplicate.error as Error).message} />}
      {isLoading ? (
        <Loading />
      ) : agents.length === 0 ? (
        <EmptyState
          icon={Bot}
          title="Create your first agent"
          description="Start from a template like customer support or lead qualification, then make it your own."
          action={<Button onClick={() => setCreating(true)}>Create an agent</Button>}
        />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>Agent</th>
              <th>Status</th>
              <th>Model</th>
              <th>Live version</th>
              <th className="text-right">Conversations (30d)</th>
              <th className="text-right">Success</th>
              <th>Updated</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id} className="hover:bg-slate-50 dark:hover:bg-slate-900">
                <td>
                  <Link href={`/agents/${a.id}`} className="font-medium hover:underline">
                    {a.name}
                  </Link>
                  {a.description && <p className="line-clamp-1 max-w-xs text-xs text-[var(--muted)]">{a.description}</p>}
                </td>
                <td>
                  {a.disabledByAdmin ? <Badge tone="red">Disabled by support</Badge> : a.status === "active" ? <Badge tone="green">Active</Badge> : <Badge tone="amber">Off</Badge>}
                </td>
                <td className="text-[var(--muted)]">{a.modelName ?? "—"}</td>
                <td>{a.publishedVersionNo ? `v${a.publishedVersionNo}` : <span className="text-[var(--muted)]">Not published</span>}</td>
                <td className="text-right tabular-nums">{a.runs30d.toLocaleString()}</td>
                <td className="text-right tabular-nums">{formatPercent(a.successRate30d)}</td>
                <td className="text-[var(--muted)]">{timeAgo(a.updatedAt)}</td>
                <td className="text-right whitespace-nowrap">
                  <Button variant="ghost" size="sm" onClick={() => duplicate.mutate(a.id)} disabled={duplicate.isPending} aria-label={`Duplicate ${a.name}`} title="Duplicate">
                    <Copy className="size-3.5" />
                  </Button>
                  {isAdmin && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
                      onClick={() => setDeleting(a)}
                      aria-label={`Delete ${a.name}`}
                      title="Delete"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <CreateAgentDialog open={creating} onClose={() => setCreating(false)} />
      <DeleteAgentDialog agent={deleting} onClose={() => setDeleting(null)} />
    </div>
  );
}

interface Draft {
  name: string;
  role: string;
  tone: string;
  instructions: string;
  welcomeMessage: string;
  needsKnowledge: boolean;
}

function CreateAgentDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: templates } = useQuery({ queryKey: ["agent-templates"], queryFn: () => api<{ data: Template[] }>("/api/v1/agents/templates"), enabled: open });
  const [mode, setMode] = useState<"describe" | "template">("describe");
  const [templateKey, setTemplateKey] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [brief, setBrief] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);

  const generate = useMutation({
    mutationFn: () => api<Draft>("/api/v1/agents/generate", { method: "POST", body: JSON.stringify({ description: brief }) }),
    onSuccess: (d) => {
      setDraft(d);
      setName(d.name);
    },
  });

  const create = useMutation({
    mutationFn: () =>
      api<{ id: string }>("/api/v1/agents", {
        method: "POST",
        body: JSON.stringify(
          mode === "describe" && draft
            ? { name, description: brief.slice(0, 500), draft }
            : { name, description: description || undefined, templateKey: templateKey ?? undefined },
        ),
      }),
    onSuccess: (agent) => {
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      router.push(`/agents/${agent.id}`);
    },
  });

  const choices: Array<Omit<Template, "key"> & { key: string | null }> = [
    { key: null, name: "Start from scratch", description: "A blank agent you configure yourself.", custom: false },
    ...(templates?.data ?? []),
  ];
  const deleteTemplate = useMutation({
    mutationFn: (id: string) => api(`/api/v1/agent-templates/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      setTemplateKey(null);
      queryClient.invalidateQueries({ queryKey: ["agent-templates"] });
    },
  });
  const error = create.error ?? generate.error;

  return (
    <Dialog open={open} onClose={onClose} title="Create an agent" wide>
      <div className="space-y-5">
        <Tabs
          value={mode}
          onChange={setMode}
          items={[
            { value: "describe", label: "Describe it" },
            { value: "template", label: "Use a template" },
          ]}
        />

        {mode === "describe" && !draft && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              generate.mutate();
            }}
          >
            <Field label="What should your agent do?" htmlFor="brief" hint="Mention your business, who it talks to, what it should help with and when to hand off to your team.">
              <Textarea
                id="brief"
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                maxLength={4000}
                className="min-h-32"
                placeholder="We run a dental clinic in Pune. The agent should answer questions about treatments and timings, and collect appointment requests with the patient's name and phone number."
              />
            </Field>
            <FormError message={error instanceof ApiError ? error.message : error ? "Something went wrong." : null} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={brief.trim().length < 10 || generate.isPending}>
                <Sparkles className="size-4" /> {generate.isPending ? "Writing…" : "Write my agent"}
              </Button>
            </div>
          </form>
        )}

        {mode === "describe" && draft && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            <Notice>Here&apos;s a first draft. Edit anything now or later in the builder.</Notice>
            <Field label="Name" htmlFor="d-name">
              <Input id="d-name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} required />
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Role" htmlFor="d-role">
                <Input id="d-role" value={draft.role} maxLength={200} onChange={(e) => setDraft({ ...draft, role: e.target.value })} />
              </Field>
              <Field label="Tone" htmlFor="d-tone">
                <Input id="d-tone" value={draft.tone} maxLength={200} onChange={(e) => setDraft({ ...draft, tone: e.target.value })} />
              </Field>
            </div>
            <Field label="Instructions" htmlFor="d-instr">
              <Textarea id="d-instr" value={draft.instructions} onChange={(e) => setDraft({ ...draft, instructions: e.target.value })} className="min-h-48 font-mono text-[13px]" />
            </Field>
            <Field label="Welcome message" htmlFor="d-welcome">
              <Input id="d-welcome" value={draft.welcomeMessage} maxLength={300} onChange={(e) => setDraft({ ...draft, welcomeMessage: e.target.value })} />
            </Field>
            {draft.needsKnowledge && <Hint>Tip: after creating it, add your documents under Knowledge so the agent can answer from them.</Hint>}
            <FormError message={error instanceof ApiError ? error.message : error ? "Couldn't create the agent." : null} />
            <div className="flex justify-between gap-2">
              <Button type="button" variant="ghost" onClick={() => setDraft(null)}>
                Start over
              </Button>
              <Button type="submit" disabled={!name.trim() || create.isPending}>
                {create.isPending ? "Creating…" : "Create agent"}
              </Button>
            </div>
          </form>
        )}

        {mode === "template" && (
          <form
            className="space-y-5"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate();
            }}
          >
            {[
              { title: "Your templates", items: choices.filter((t) => t.custom), empty: "None yet. Open any agent and click “Save as template” to reuse its setup here." },
              { title: "Built-in", items: choices.filter((t) => !t.custom), empty: "" },
            ].map((group) => (
              <div key={group.title}>
                <p className="mb-2 text-sm font-medium">{group.title}</p>
                {group.items.length === 0 ? (
                  <p className="text-xs text-[var(--muted)]">{group.empty}</p>
                ) : (
                  <div className="grid gap-2 sm:grid-cols-2">
                    {group.items.map((t) => (
                      <div
                        key={t.key ?? "blank"}
                        className={cn(
                          "relative rounded-lg border text-sm transition-colors",
                          templateKey === t.key ? "border-brand-600 bg-brand-50 dark:bg-slate-800" : "border-[var(--border)] hover:bg-slate-50 dark:hover:bg-slate-900",
                        )}
                      >
                        <button
                          type="button"
                          className="w-full p-3 pr-9 text-left"
                          onClick={() => {
                            setTemplateKey(t.key);
                            if (!name && t.key) setName(t.name);
                          }}
                        >
                          <p className="font-medium">{t.name}</p>
                          <p className="mt-0.5 line-clamp-2 text-xs text-[var(--muted)]">{t.description}</p>
                        </button>
                        {t.custom && t.id && (
                          <button
                            type="button"
                            aria-label={`Delete template ${t.name}`}
                            className="absolute top-2 right-2 rounded p-1 text-[var(--muted)] hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950"
                            onClick={() => confirm(`Delete the template "${t.name}"? Agents already created from it aren't affected.`) && deleteTemplate.mutate(t.id!)}
                          >
                            <Trash2 className="size-3.5" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <Field label="Name" htmlFor="agent-name">
              <Input id="agent-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required placeholder="e.g. Acme Support Assistant" />
            </Field>
            <Field label="Description (optional)" htmlFor="agent-desc">
              <Textarea id="agent-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} className="min-h-16" />
            </Field>
            <FormError message={error instanceof ApiError ? error.message : error ? "Couldn't create the agent." : null} />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="secondary" onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={!name.trim() || create.isPending}>
                {create.isPending ? "Creating…" : "Create agent"}
              </Button>
            </div>
          </form>
        )}
      </div>
    </Dialog>
  );
}
