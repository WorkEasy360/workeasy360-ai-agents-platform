"use client";

import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Users } from "lucide-react";
import { Badge, Button, EmptyState, Input, Loading, PageHeader, Table } from "@/components/ui";
import { ADMIN_API, FilterBar, OffsetPager, QueryError, qs } from "@/components/admin/shared";
import type { Page, UserRow } from "@/components/admin/types";
import { api } from "@/lib/api";
import { formatDate, formatNumber, timeAgo } from "@/lib/format";

const LIMIT = 50;

export default function AdminUsersPage() {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [offset, setOffset] = useState(0);

  const users = useQuery({
    queryKey: ["admin", "users", { q, offset }],
    queryFn: () => api<Page<UserRow>>(`${ADMIN_API}/users${qs({ q, limit: LIMIT, offset })}`),
    placeholderData: (prev) => prev,
  });
  const rows = users.data?.data ?? [];

  return (
    <div>
      <PageHeader title="Users" description="All accounts across every organization." />
      <FilterBar
        onSubmit={() => {
          setQ(search.trim());
          setOffset(0);
        }}
      >
        <Input className="sm:w-72" placeholder="Search email or name" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search users" />
        <Button type="submit" variant="secondary">
          Search
        </Button>
      </FilterBar>

      {users.error ? (
        <QueryError error={users.error} />
      ) : users.isLoading ? (
        <Loading />
      ) : rows.length === 0 ? (
        <EmptyState icon={Users} title="No users found" />
      ) : (
        <Table>
          <thead>
            <tr>
              <th>User</th>
              <th>Status</th>
              <th>Role</th>
              <th>2FA</th>
              <th className="text-right">Orgs</th>
              <th>Last seen</th>
              <th>Joined</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((u) => (
              <tr key={u.id}>
                <td>
                  <Link href={`/admin/users/${u.id}`} className="font-medium text-brand-700 hover:underline dark:text-brand-100">
                    {u.name}
                  </Link>
                  <p className="text-xs text-[var(--muted)]">
                    {u.email}
                    {!u.emailVerified && " · unverified"}
                  </p>
                </td>
                <td>{u.bannedAt ? <Badge tone="red">banned</Badge> : <Badge tone="green">active</Badge>}</td>
                <td>{u.platformRole ? <Badge tone="blue">{u.platformRole.replace("_", " ")}</Badge> : <span className="text-[var(--muted)]">—</span>}</td>
                <td>{u.twoFactorEnabled ? "On" : <span className="text-[var(--muted)]">Off</span>}</td>
                <td className="text-right tabular-nums">{formatNumber(u.orgs)}</td>
                <td className="whitespace-nowrap">{timeAgo(u.lastSeenAt)}</td>
                <td className="whitespace-nowrap">{formatDate(u.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      <OffsetPager offset={offset} limit={LIMIT} count={rows.length} onChange={setOffset} />
    </div>
  );
}
