"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Card, FormError, Input, Label, Select, Table } from "@/components/ui";
import { getActiveOrgId } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { useMe } from "@/lib/use-me";

export default function MembersPage() {
  const { data: me } = useMe();
  const orgId = getActiveOrgId() ?? me?.organizations[0]?.id;
  const myRole = me?.organizations.find((o) => o.id === orgId)?.role;
  const canInvite = myRole === "owner" || myRole === "admin";

  const queryClient = useQueryClient();
  const { data: org, isLoading } = useQuery({
    queryKey: ["org-full", orgId],
    enabled: Boolean(orgId),
    queryFn: async () => {
      const { data, error } = await authClient.organization.getFullOrganization({ query: { organizationId: orgId! } });
      if (error) throw new Error(error.message);
      return data;
    },
  });

  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onInvite(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const email = String(form.get("email")).trim();
    setPending(true);
    setError(null);
    setSent(null);
    const { error } = await authClient.organization.inviteMember({
      email,
      role: form.get("role") as "member" | "admin",
      organizationId: orgId!,
    });
    setPending(false);
    if (error) return setError(error.message ?? "Couldn't send the invitation.");
    setSent(email);
    formEl.reset();
    await queryClient.invalidateQueries({ queryKey: ["org-full", orgId] });
  }

  const pendingInvites = org?.invitations.filter((i) => i.status === "pending") ?? [];

  return (
    <div className="space-y-6">
      <p className="text-sm text-[var(--muted)]">People who can build and manage agents in this organization.</p>

      {canInvite && (
        <Card>
          <h2 className="mb-4 font-medium">Invite a teammate</h2>
          <form onSubmit={onInvite} className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div className="flex-1">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" required placeholder="name@company.com" />
            </div>
            <div className="sm:w-36">
              <Label htmlFor="role">Role</Label>
              <Select id="role" name="role" defaultValue="member">
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </Select>
            </div>
            <Button type="submit" disabled={pending}>
              {pending ? "Sending…" : "Send invite"}
            </Button>
          </form>
          <p className="mt-2 text-xs text-[var(--muted)]">Admins can also manage credentials, AI keys and API keys.</p>
          <div className="mt-3">
            <FormError message={error} />
            {sent && <p className="text-sm text-green-700 dark:text-green-400">Invitation sent to {sent}.</p>}
          </div>
        </Card>
      )}

      <Table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Role</th>
          </tr>
        </thead>
        <tbody>
          {isLoading && (
            <tr>
              <td className="text-[var(--muted)]" colSpan={3}>
                Loading…
              </td>
            </tr>
          )}
          {org?.members.map((m) => (
            <tr key={m.id}>
              <td className="whitespace-nowrap">{m.user.name}</td>
              <td>{m.user.email}</td>
              <td className="capitalize">{m.role}</td>
            </tr>
          ))}
          {pendingInvites.map((i) => (
            <tr key={i.id} className="text-[var(--muted)]">
              <td className="italic">Invited</td>
              <td>{i.email}</td>
              <td className="whitespace-nowrap capitalize">{i.role} · pending</td>
            </tr>
          ))}
        </tbody>
      </Table>
    </div>
  );
}
