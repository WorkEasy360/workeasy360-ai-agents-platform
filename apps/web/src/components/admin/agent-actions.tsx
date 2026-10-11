"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, FormError } from "@/components/ui";
import { api } from "@/lib/api";
import { ADMIN_API, errorText, ReasonDialog, useIsSuperAdmin } from "./shared";

/**
 * Disable (support + super_admin, reason required) or re-enable (super_admin only) an agent.
 * Invalidates every admin query that lists agents.
 */
export function AgentActions({ agent }: { agent: { id: string; name: string; disabledByAdminAt: string | null } }) {
  const qc = useQueryClient();
  const isSuper = useIsSuperAdmin();
  const [open, setOpen] = useState(false);

  const invalidate = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: ["admin", "agents"] }),
      qc.invalidateQueries({ queryKey: ["admin", "org"] }),
      qc.invalidateQueries({ queryKey: ["admin", "overview"] }),
    ]);

  const disable = useMutation({
    mutationFn: (reason: string) => api(`${ADMIN_API}/agents/${agent.id}/disable`, { method: "POST", body: JSON.stringify({ reason }) }),
    onSuccess: async () => {
      setOpen(false);
      await invalidate();
    },
  });
  const enable = useMutation({
    mutationFn: () => api(`${ADMIN_API}/agents/${agent.id}/enable`, { method: "POST" }),
    onSuccess: invalidate,
  });

  if (agent.disabledByAdminAt) {
    if (!isSuper) return <span className="text-xs text-[var(--muted)]">Disabled</span>;
    return (
      <div className="space-y-1">
        <Button size="sm" variant="secondary" disabled={enable.isPending} onClick={() => enable.mutate()}>
          {enable.isPending ? "Enabling…" : "Enable"}
        </Button>
        <FormError message={errorText(enable.error)} />
      </div>
    );
  }

  return (
    <>
      <Button size="sm" variant="secondary" className="text-red-600 dark:text-red-400" onClick={() => setOpen(true)}>
        Disable
      </Button>
      <ReasonDialog
        open={open}
        onClose={() => {
          setOpen(false);
          disable.reset();
        }}
        title={`Disable ${agent.name}`}
        description="All channels for this agent stop immediately. The organization can't re-enable it; only a super admin can."
        confirmLabel="Disable agent"
        danger
        pending={disable.isPending}
        error={disable.error}
        onConfirm={(reason) => disable.mutate(reason)}
      />
    </>
  );
}
