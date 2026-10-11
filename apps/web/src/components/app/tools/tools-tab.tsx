"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { FlaskConical, KeyRound, Mail, Pencil, Plus, Trash2, Wrench } from "lucide-react";
import { Badge, Button, Card, EmptyState, FormError, Loading } from "@/components/ui";
import { ConfirmDialog, errorMessage } from "@/components/app/misc";
import type { Tool } from "@/components/app/types";
import { api } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { EmailToolFormDialog } from "./email-tool";
import { ToolFormDialog } from "./tool-form";
import { ToolTestDialog } from "./tool-test";

export function ToolsTab() {
  const qc = useQueryClient();
  const { data, isLoading, error } = useQuery({ queryKey: ["tools"], queryFn: () => api<{ data: Tool[] }>("/api/v1/tools") });
  const tools = data?.data ?? [];

  // `editing`: undefined = closed, null = creating, Tool = editing.
  const [editing, setEditing] = useState<Tool | null | undefined>(undefined);
  // Same convention for email tools.
  const [editingEmail, setEditingEmail] = useState<Tool | null | undefined>(undefined);
  const [testing, setTesting] = useState<Tool | null>(null);
  const [deleting, setDeleting] = useState<Tool | null>(null);

  const usage = useQuery({
    queryKey: ["tool-usage", deleting?.id],
    enabled: !!deleting,
    queryFn: () => api<{ versions: number }>(`/api/v1/tools/${deleting!.id}/usage`),
  });
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/tools/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      setDeleting(null);
      await qc.invalidateQueries({ queryKey: ["tools"] });
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-[var(--muted)]">Tools let agents call your APIs or email your team. Add tools here, then switch them on for an agent.</p>
        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" onClick={() => setEditingEmail(null)}>
            <Mail className="size-4" /> New email tool
          </Button>
          <Button onClick={() => setEditing(null)}>
            <Plus className="size-4" /> New API tool
          </Button>
        </div>
      </div>

      <FormError message={errorMessage(error)} />
      {isLoading ? (
        <Loading />
      ) : tools.length === 0 ? (
        <EmptyState
          icon={Wrench}
          title="No tools yet"
          description="Connect an agent to your own systems. For example: look up an order status, check stock, or add a lead to your CRM."
          action={<Button onClick={() => setEditing(null)}>Create your first tool</Button>}
        />
      ) : (
        <div className="space-y-3">
          {tools.map((t) => (
            <Card key={t.id} className="p-4">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="font-mono text-sm font-medium">{t.name}</p>
                  <p className="mt-1 text-sm text-[var(--muted)]">{t.description}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                    {t.providerKey === "send_email" ? (
                      <>
                        <Badge tone="blue">EMAIL</Badge>
                        <span className="truncate text-[var(--muted)]">to {(t.config.recipients ?? []).join(", ")}</span>
                      </>
                    ) : (
                      <>
                        <Badge tone="blue">{t.config.method}</Badge>
                        <code className="max-w-full truncate text-[var(--muted)]">{t.config.url}</code>
                      </>
                    )}
                    {t.credentialName ? (
                      <Badge>
                        <KeyRound className="mr-1 size-3" />
                        {t.credentialName}
                      </Badge>
                    ) : null}
                    <span className="text-[var(--muted)]">· updated {timeAgo(t.updatedAt)}</span>
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button size="sm" variant="secondary" onClick={() => setTesting(t)}>
                    <FlaskConical className="size-3.5" /> Test
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => (t.providerKey === "send_email" ? setEditingEmail(t) : setEditing(t))} aria-label={`Edit ${t.name}`}>
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setDeleting(t)} aria-label={`Delete ${t.name}`}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}

      <ToolFormDialog
        open={editing !== undefined}
        tool={editing ?? null}
        onClose={() => setEditing(undefined)}
        onSaved={(t) => {
          setEditing(undefined);
          setTesting(t);
        }}
      />
      <EmailToolFormDialog
        open={editingEmail !== undefined}
        tool={editingEmail ?? null}
        onClose={() => setEditingEmail(undefined)}
        onSaved={() => setEditingEmail(undefined)}
      />
      <ToolTestDialog tool={testing} onClose={() => setTesting(null)} />
      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete tool?"
        message={
          <div className="space-y-2">
            <p>
              <strong className="font-mono">{deleting?.name}</strong> will be removed.
            </p>
            {usage.data && usage.data.versions > 0 && (
              <p className="text-amber-700 dark:text-amber-300">
                It&apos;s used by {usage.data.versions} published agent {usage.data.versions === 1 ? "version" : "versions"}. Those agents will no longer be able to use it.
              </p>
            )}
          </div>
        }
        pending={remove.isPending}
        error={errorMessage(remove.error)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  );
}
