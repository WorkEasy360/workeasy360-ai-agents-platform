"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ConfirmDialog, errorMessage } from "@/components/app/misc";
import { api } from "@/lib/api";

/** Confirms and deletes an agent. Its chat page, widget and API access stop working immediately. */
export function DeleteAgentDialog({ agent, onClose, onDeleted }: { agent: { id: string; name: string } | null; onClose: () => void; onDeleted?: () => void }) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: (id: string) => api(`/api/v1/agents/${id}`, { method: "DELETE" }),
    onSuccess: async (_data, id) => {
      queryClient.removeQueries({ queryKey: ["agent", id] });
      await queryClient.invalidateQueries({ queryKey: ["agents"] });
      onClose();
      onDeleted?.();
    },
  });

  return (
    <ConfirmDialog
      open={agent !== null}
      onClose={() => {
        remove.reset();
        onClose();
      }}
      title="Delete agent?"
      message={
        <div className="space-y-2">
          <p>
            <strong>{agent?.name}</strong> will be deleted.
          </p>
          <p>Its chat page link, website widget and API access stop working right away. Its conversations stay in Logs for 30 days, then the agent and its conversations are deleted for good.</p>
          <p className="text-[var(--muted)]">Tip: to pause it instead, use the on/off switch on the agent page.</p>
        </div>
      }
      confirmLabel="Delete agent"
      pending={remove.isPending}
      error={errorMessage(remove.error)}
      onConfirm={() => agent && remove.mutate(agent.id)}
    />
  );
}
