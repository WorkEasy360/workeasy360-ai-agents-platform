"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Download } from "lucide-react";
import { Button, Card, Field, FormError, Hint, Input, Notice } from "@/components/ui";
import { ApiError, getActiveOrgId, setActiveOrgId } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { useMe } from "@/lib/use-me";

export default function OrganizationSettingsPage() {
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const router = useRouter();
  const org = me?.organizations.find((o) => o.id === getActiveOrgId()) ?? me?.organizations[0];
  const isOwner = org?.role === "owner";
  const canEdit = org?.role === "owner" || org?.role === "admin";

  const [name, setName] = useState(org?.name ?? "");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [deleting, setDeleting] = useState(false);

  if (!org) return null;

  async function rename(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const { error } = await authClient.organization.update({ organizationId: org!.id, data: { name: name.trim() } });
    if (error) return setError(error.message ?? "Couldn't rename the organization.");
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
    queryClient.invalidateQueries({ queryKey: ["me"] });
  }

  async function exportData() {
    setExporting(true);
    setError(null);
    try {
      // The org is chosen by header, so download via fetch instead of a plain link.
      const res = await fetch("/api/v1/organization/export", { headers: { "x-org-id": org!.id }, credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new ApiError(res.status, body.code ?? "error", body.detail ?? "Export failed.");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = res.headers.get("content-disposition")?.match(/filename="([^"]+)"/)?.[1] ?? "export.json";
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setExporting(false);
    }
  }

  async function deleteOrg(e: React.FormEvent) {
    e.preventDefault();
    setDeleting(true);
    setError(null);
    const { error } = await authClient.organization.delete({ organizationId: org!.id });
    setDeleting(false);
    if (error) return setError(error.message ?? "Couldn't delete the organization.");
    const next = me!.organizations.find((o) => o.id !== org!.id);
    if (next) setActiveOrgId(next.id);
    queryClient.clear();
    router.replace(next ? "/" : "/onboarding");
  }

  return (
    <div className="max-w-2xl space-y-6">
      <Card>
        <form onSubmit={rename} className="space-y-4">
          <Field label="Organization name" htmlFor="org-name">
            <Input id="org-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} disabled={!canEdit} />
          </Field>
          {canEdit && (
            <Button type="submit" disabled={!name.trim() || name === org.name}>
              {saved ? "Saved" : "Save"}
            </Button>
          )}
        </form>
      </Card>

      <Card className="space-y-3">
        <h2 className="font-medium">Export your data</h2>
        <p className="text-sm text-[var(--muted)]">
          Download a JSON file with your agents, versions, knowledge base list, tools, channels and all conversations. Secrets and API keys are never included.
        </p>
        {isOwner ? (
          <Button variant="secondary" onClick={exportData} disabled={exporting}>
            <Download className="size-4" /> {exporting ? "Preparing…" : "Download export"}
          </Button>
        ) : (
          <Hint>Only the organization owner can export data.</Hint>
        )}
      </Card>

      {isOwner && (
        <Card className="space-y-3 border-red-200 dark:border-red-900">
          <h2 className="font-medium text-red-700 dark:text-red-400">Delete organization</h2>
          <Notice tone="warning">
            This permanently deletes all agents, knowledge, uploaded files, tools, channels, conversations and logs for <strong>{org.name}</strong>. It can&apos;t be undone.
          </Notice>
          <form onSubmit={deleteOrg} className="space-y-3">
            <Field label={`Type "${org.name}" to confirm`} htmlFor="confirm-name">
              <Input id="confirm-name" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} autoComplete="off" />
            </Field>
            <Button type="submit" variant="danger" disabled={confirmName !== org.name || deleting}>
              {deleting ? "Deleting…" : "Delete organization"}
            </Button>
          </form>
        </Card>
      )}
      <FormError message={error} />
    </div>
  );
}
