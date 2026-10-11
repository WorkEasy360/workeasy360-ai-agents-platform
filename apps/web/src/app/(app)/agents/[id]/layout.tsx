"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowLeft, BookmarkPlus, Rocket, Trash2 } from "lucide-react";
import { DeleteAgentDialog } from "@/components/app/delete-agent";
import { useRole } from "@/components/app/use-role";
import { Badge, Button, Dialog, Field, FormError, Input, Loading, Notice, Toggle } from "@/components/ui";
import { api, ApiError } from "@/lib/api";
import { useAgent } from "@/lib/agents";
import { cn } from "@/lib/cn";
import { EditorProvider, useEditor } from "./editor-context";

export default function AgentLayout({ children }: { children: React.ReactNode }) {
  return (
    <EditorProvider>
      <AgentShell>{children}</AgentShell>
    </EditorProvider>
  );
}

function AgentShell({ children }: { children: React.ReactNode }) {
  const { id } = useParams<{ id: string }>();
  const pathname = usePathname();
  const { data: agent, isLoading, error } = useAgent(id);
  const queryClient = useQueryClient();
  const [publishing, setPublishing] = useState(false);
  const [savingTemplate, setSavingTemplate] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { isAdmin } = useRole();
  const router = useRouter();

  const setStatus = useMutation({
    mutationFn: (status: "active" | "disabled") => api(`/api/v1/agents/${id}/status`, { method: "POST", body: JSON.stringify({ status }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["agent", id] }),
  });

  if (isLoading) return <Loading />;
  if (error || !agent) return <Notice tone="warning">{error instanceof ApiError ? error.message : "Agent not found."}</Notice>;

  const tabs = [
    { href: `/agents/${id}`, label: "Build" },
    { href: `/agents/${id}/deploy`, label: "Deploy" },
    { href: `/agents/${id}/monitor`, label: "Monitor" },
    { href: `/agents/${id}/versions`, label: "Versions" },
  ];

  return (
    <div className="mx-auto max-w-7xl">
      <Link href="/agents" className="mb-3 inline-flex items-center gap-1 text-sm text-[var(--muted)] hover:text-[var(--foreground)]">
        <ArrowLeft className="size-3.5" /> Agents
      </Link>
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-2xl font-semibold">{agent.name}</h1>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-sm">
            {agent.publishedVersion ? <Badge tone="green">Live: v{agent.publishedVersion.versionNo}</Badge> : <Badge>Not published</Badge>}
            {agent.publishedVersion && agent.hasUnpublishedChanges && <Badge tone="amber">Unpublished changes</Badge>}
            {agent.disabledByAdminAt && <Badge tone="red">Disabled by support</Badge>}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Toggle
            label={agent.status === "active" ? "Agent on" : "Agent off"}
            checked={agent.status === "active"}
            disabled={Boolean(agent.disabledByAdminAt) || setStatus.isPending}
            onChange={(v) => setStatus.mutate(v ? "active" : "disabled")}
          />
          {isAdmin && (
            <Button variant="ghost" className="text-red-600 hover:bg-red-50 dark:hover:bg-red-950" onClick={() => setDeleting(true)} aria-label="Delete agent" title="Delete agent">
              <Trash2 className="size-4" />
            </Button>
          )}
          <Button variant="secondary" onClick={() => setSavingTemplate(true)}>
            <BookmarkPlus className="size-4" /> Save as template
          </Button>
          <Button onClick={() => setPublishing(true)} disabled={agent.publishedVersion !== null && !agent.hasUnpublishedChanges}>
            <Rocket className="size-4" /> Publish
          </Button>
        </div>
      </div>
      {setStatus.error && <FormError message={(setStatus.error as Error).message} />}
      <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-[var(--border)]">
        {tabs.map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap",
              pathname === t.href ? "border-brand-600 font-medium text-brand-700 dark:text-white" : "border-transparent text-[var(--muted)] hover:text-[var(--foreground)]",
            )}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {children}
      <PublishDialog agentId={id} open={publishing} onClose={() => setPublishing(false)} />
      <DeleteAgentDialog agent={deleting ? { id, name: agent.name } : null} onClose={() => setDeleting(false)} onDeleted={() => router.replace("/agents")} />
      <SaveTemplateDialog agentId={id} agentName={agent.name} agentDescription={agent.description} open={savingTemplate} onClose={() => setSavingTemplate(false)} />
    </div>
  );
}

/** Saves this agent's current setup (draft) as a reusable template for new agents. */
function SaveTemplateDialog({
  agentId,
  agentName,
  agentDescription,
  open,
  onClose,
}: {
  agentId: string;
  agentName: string;
  agentDescription: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const { flush } = useEditor();
  const [name, setName] = useState(`${agentName} template`);
  const [description, setDescription] = useState(agentDescription ?? "");
  const [done, setDone] = useState(false);
  const save = useMutation({
    mutationFn: async () => {
      await flush();
      return api("/api/v1/agent-templates", { method: "POST", body: JSON.stringify({ agentId, name, description: description || undefined }) });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent-templates"] });
      setDone(true);
    },
  });
  const close = () => {
    setDone(false);
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} title="Save as template">
      {done ? (
        <div className="space-y-4">
          <Notice tone="success">Saved. You&apos;ll find it under “Your templates” when you create a new agent.</Notice>
          <div className="flex justify-end">
            <Button onClick={close}>Done</Button>
          </div>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate();
          }}
        >
          <p className="text-sm text-[var(--muted)]">
            Saves this agent&apos;s instructions, model, knowledge, tools and settings (the current draft). New agents created from it start with
            the same setup; this agent isn&apos;t changed.
          </p>
          <Field label="Template name" htmlFor="tpl-name">
            <Input id="tpl-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required />
          </Field>
          <Field label="Description (optional)" htmlFor="tpl-desc">
            <Input id="tpl-desc" value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
          </Field>
          <FormError message={save.error ? (save.error as Error).message : null} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || save.isPending}>
              {save.isPending ? "Saving…" : "Save template"}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function PublishDialog({ agentId, open, onClose }: { agentId: string; open: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { flush } = useEditor();
  const [note, setNote] = useState("");
  const publish = useMutation({
    mutationFn: async () => {
      await flush();
      return api<{ versionNo: number }>(`/api/v1/agents/${agentId}/publish`, { method: "POST", body: JSON.stringify({ changeNote: note || undefined }) });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["agent", agentId] });
      queryClient.invalidateQueries({ queryKey: ["agent-versions", agentId] });
      queryClient.invalidateQueries({ queryKey: ["agents"] });
      setNote("");
      onClose();
    },
  });
  const problems = publish.error instanceof ApiError ? publish.error.errors?.map((e) => e.message) : undefined;

  return (
    <Dialog open={open} onClose={onClose} title="Publish a new version">
      <div className="space-y-4">
        <p className="text-sm text-[var(--muted)]">
          Everything connected to this agent (chat page, website widget, API) switches to the new version right away, unless you pinned an older version on the Deploy tab.
        </p>
        <Field label="What changed? (optional)" htmlFor="change-note">
          <Input id="change-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="e.g. Added refund policy documents" />
        </Field>
        {problems?.length ? (
          <Notice tone="warning">
            <ul className="list-disc pl-4">
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </Notice>
        ) : (
          <FormError message={publish.error ? (publish.error as Error).message : null} />
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => publish.mutate()} disabled={publish.isPending}>
            {publish.isPending ? "Publishing…" : "Publish"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
