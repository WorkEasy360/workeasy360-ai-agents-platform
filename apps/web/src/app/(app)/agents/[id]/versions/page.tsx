"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { Badge, Button, EmptyState, FormError, Loading, Table } from "@/components/ui";
import { api } from "@/lib/api";
import { useAgent, useVersions } from "@/lib/agents";
import { formatDateTime } from "@/lib/format";
import { History } from "lucide-react";

export default function VersionsPage() {
  const { id } = useParams<{ id: string }>();
  const { data: agent } = useAgent(id);
  const { data, isLoading } = useVersions(id);
  const queryClient = useQueryClient();
  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ["agent", id] });
    queryClient.invalidateQueries({ queryKey: ["agent-versions", id] });
  };

  const activate = useMutation({
    mutationFn: (versionId: string) => api(`/api/v1/agents/${id}/versions/${versionId}/activate`, { method: "POST" }),
    onSuccess: refresh,
  });
  const restore = useMutation({
    mutationFn: (versionId: string) => api(`/api/v1/agents/${id}/versions/${versionId}/restore`, { method: "POST" }),
    onSuccess: () => {
      refresh();
      // The Build page keeps its own copy of the draft; reload it from the server.
      window.location.href = `/agents/${id}`;
    },
  });

  if (isLoading) return <Loading />;
  const versions = data?.data ?? [];
  if (versions.length === 0) {
    return <EmptyState icon={History} title="No versions yet" description="Every time you publish, a version is saved here so you can go back to it." />;
  }

  return (
    <div className="max-w-4xl space-y-3">
      <FormError message={(activate.error ?? restore.error) ? ((activate.error ?? restore.error) as Error).message : null} />
      <Table>
        <thead>
          <tr>
            <th>Version</th>
            <th>What changed</th>
            <th>Published</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {versions.map((v) => {
            const live = agent?.publishedVersionId === v.id;
            return (
              <tr key={v.id}>
                <td className="font-medium">
                  v{v.versionNo} {live && <Badge tone="green" className="ml-1">Live</Badge>}
                </td>
                <td className="text-[var(--muted)]">{v.changeNote ?? "—"}</td>
                <td className="text-[var(--muted)]">{formatDateTime(v.publishedAt)}</td>
                <td className="text-right whitespace-nowrap">
                  {!live && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={activate.isPending}
                      onClick={() => confirm(`Make v${v.versionNo} live again? Channels on "latest" switch immediately.`) && activate.mutate(v.id)}
                    >
                      Make live
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    className="ml-1"
                    disabled={restore.isPending}
                    onClick={() => confirm(`Replace your current draft with v${v.versionNo}? Unpublished changes will be lost.`) && restore.mutate(v.id)}
                  >
                    Edit from this version
                  </Button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </Table>
    </div>
  );
}
