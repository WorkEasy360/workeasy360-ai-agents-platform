"use client";

import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ArrowLeft } from "lucide-react";
import { Badge, Button, Card, Dialog, FormError, Loading, Notice, PageHeader, Select, Table } from "@/components/ui";
import { ADMIN_API, QueryError, ReasonDialog, errorText, useIsSuperAdmin } from "@/components/admin/shared";
import type { PlatformRole, UserDetail } from "@/components/admin/types";
import { api } from "@/lib/api";
import { formatDate, formatDateTime, timeAgo } from "@/lib/format";
import { useMe } from "@/lib/use-me";

export default function AdminUserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const isSuper = useIsSuperAdmin();
  const { data: me } = useMe();
  const isSelf = me?.user.id === id;

  const [banOpen, setBanOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const router = useRouter();

  const user = useQuery({ queryKey: ["admin", "user", id], queryFn: () => api<UserDetail>(`${ADMIN_API}/users/${id}`) });

  const invalidate = () =>
    Promise.all([qc.invalidateQueries({ queryKey: ["admin", "user", id] }), qc.invalidateQueries({ queryKey: ["admin", "users"] })]);
  const post = (path: string, body?: unknown) =>
    api(`${ADMIN_API}/users/${id}/${path}`, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });

  const ban = useMutation({
    mutationFn: (reason: string) => post("ban", { reason }),
    onSuccess: async () => {
      setBanOpen(false);
      await invalidate();
    },
  });
  const unban = useMutation({ mutationFn: () => post("unban"), onSuccess: invalidate });
  const revoke = useMutation({
    mutationFn: () => post("revoke-sessions"),
    onSuccess: async () => {
      setRevokeOpen(false);
      await invalidate();
    },
  });
  // Erasure request received by support. Blocked if the user is the only owner of a shared organization.
  const remove = useMutation({
    mutationFn: () => api(`${ADMIN_API}/users/${id}`, { method: "DELETE" }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["admin", "users"] });
      router.replace("/admin/users");
    },
  });
  const setRole = useMutation({
    mutationFn: (role: PlatformRole | null) => post("platform-role", { role }),
    onSuccess: invalidate,
  });

  if (user.error) return <QueryError error={user.error} />;
  if (!user.data) return <Loading />;
  const u = user.data;

  return (
    <div className="space-y-6">
      <Link href="/admin/users" className="inline-flex items-center gap-1 text-sm text-[var(--muted)] hover:text-[var(--foreground)]">
        <ArrowLeft className="size-4" /> Users
      </Link>

      <PageHeader
        title={u.name}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span>{u.email}</span>
            {u.bannedAt ? <Badge tone="red">banned</Badge> : <Badge tone="green">active</Badge>}
            {u.platformRole && <Badge tone="blue">{u.platformRole.replace("_", " ")}</Badge>}
            <span>Joined {formatDate(u.createdAt)}</span>
          </span>
        }
        actions={
          isSuper &&
          !isSelf && (
            <>
              <Button variant="secondary" onClick={() => setRevokeOpen(true)}>
                Revoke sessions
              </Button>
              {u.bannedAt ? (
                <Button variant="secondary" disabled={unban.isPending} onClick={() => unban.mutate()}>
                  {unban.isPending ? "Unbanning…" : "Unban"}
                </Button>
              ) : (
                <Button variant="danger" onClick={() => setBanOpen(true)}>
                  Ban user
                </Button>
              )}
              <Button variant="secondary" className="text-red-600" onClick={() => setDeleteOpen(true)}>
                Delete account
              </Button>
            </>
          )
        }
      />
      <FormError message={errorText(unban.error)} />

      {u.bannedAt && (
        <Notice tone="warning">
          Banned {formatDateTime(u.bannedAt)}
          {u.banReason ? `: ${u.banReason}` : "."}
        </Notice>
      )}

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <h2 className="mb-3 font-medium">Account</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
            <dt className="text-[var(--muted)]">Email verified</dt>
            <dd>{u.emailVerified ? "Yes" : "No"}</dd>
            <dt className="text-[var(--muted)]">Two-factor</dt>
            <dd>{u.twoFactorEnabled ? "Enabled" : "Off"}</dd>
            <dt className="text-[var(--muted)]">User ID</dt>
            <dd className="font-mono text-xs break-all">{u.id}</dd>
          </dl>
        </Card>

        <Card>
          <h2 className="mb-1 font-medium">Platform role</h2>
          <p className="mb-3 text-xs text-[var(--muted)]">Support can view everything and disable agents. Super admins can change anything.</p>
          <Select
            aria-label="Platform role"
            className="sm:w-56"
            value={u.platformRole ?? ""}
            disabled={!isSuper || isSelf || setRole.isPending}
            onChange={(e) => setRole.mutate((e.target.value || null) as PlatformRole | null)}
          >
            <option value="">None (customer)</option>
            <option value="support">Support</option>
            <option value="super_admin">Super admin</option>
          </Select>
          {isSelf && <p className="mt-2 text-xs text-[var(--muted)]">You can&apos;t change your own role.</p>}
          {!isSuper && <p className="mt-2 text-xs text-[var(--muted)]">Only super admins can change roles.</p>}
          <div className="mt-2">
            <FormError message={errorText(setRole.error)} />
          </div>
        </Card>
      </div>

      <section>
        <h2 className="mb-3 font-medium">Organizations ({u.organizations.length})</h2>
        <Table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Plan</th>
              <th>Role</th>
            </tr>
          </thead>
          <tbody>
            {u.organizations.length === 0 && (
              <tr>
                <td colSpan={3} className="text-[var(--muted)]">
                  Not a member of any organization.
                </td>
              </tr>
            )}
            {u.organizations.map((o) => (
              <tr key={o.id}>
                <td>
                  <Link href={`/admin/organizations/${o.id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-100">
                    {o.name}
                  </Link>
                </td>
                <td className="capitalize">{o.planKey}</td>
                <td className="capitalize">{o.role}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>

      <section>
        <h2 className="mb-3 font-medium">Sessions ({u.sessions.length})</h2>
        <Table>
          <thead>
            <tr>
              <th>Last active</th>
              <th>Created</th>
              <th>IP address</th>
              <th>User agent</th>
            </tr>
          </thead>
          <tbody>
            {u.sessions.length === 0 && (
              <tr>
                <td colSpan={4} className="text-[var(--muted)]">
                  No active sessions.
                </td>
              </tr>
            )}
            {u.sessions.map((s) => (
              <tr key={s.id}>
                <td className="whitespace-nowrap">{timeAgo(s.updatedAt)}</td>
                <td className="whitespace-nowrap">{formatDateTime(s.createdAt)}</td>
                <td className="font-mono text-xs">{s.ipAddress ?? "—"}</td>
                <td className="max-w-xs truncate text-xs text-[var(--muted)]" title={s.userAgent ?? undefined}>
                  {s.userAgent ?? "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </Table>
      </section>

      <ReasonDialog
        open={banOpen}
        onClose={() => {
          setBanOpen(false);
          ban.reset();
        }}
        title={`Ban ${u.email}`}
        description="The user is signed out everywhere and can't sign in again until unbanned."
        confirmLabel="Ban user"
        danger
        pending={ban.isPending}
        error={ban.error}
        onConfirm={(reason) => ban.mutate(reason)}
      />

      <Dialog
        open={revokeOpen}
        onClose={() => {
          setRevokeOpen(false);
          revoke.reset();
        }}
        title="Revoke all sessions"
      >
        <p className="text-sm text-[var(--muted)]">{u.email} will be signed out on every device. They can sign in again unless banned.</p>
        <div className="mt-3">
          <FormError message={errorText(revoke.error)} />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setRevokeOpen(false)}>
            Cancel
          </Button>
          <Button variant="danger" disabled={revoke.isPending} onClick={() => revoke.mutate()}>
            {revoke.isPending ? "Revoking…" : "Revoke sessions"}
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onClose={() => {
          setDeleteOpen(false);
          remove.reset();
        }}
        title="Delete account permanently"
      >
        <p className="text-sm text-[var(--muted)]">
          Use this for a verified deletion request. {u.email}&apos;s profile, sign-in methods and memberships are deleted, along with any organization where they are the
          only member. This can&apos;t be undone.
        </p>
        <div className="mt-3">
          <FormError message={errorText(remove.error)} />
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setDeleteOpen(false)}>
            Cancel
          </Button>
          <Button variant="danger" disabled={remove.isPending} onClick={() => remove.mutate()}>
            {remove.isPending ? "Deleting…" : "Delete account"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
