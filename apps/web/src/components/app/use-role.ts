"use client";

import { getActiveOrgId } from "@/lib/api";
import { useMe } from "@/lib/use-me";

/** The signed-in user's role in the active organization. Admin-only UI checks `isAdmin`. */
export function useRole() {
  const { data: me } = useMe();
  const orgId = getActiveOrgId() ?? me?.activeOrganizationId ?? me?.organizations[0]?.id;
  const role = me?.organizations.find((o) => o.id === orgId)?.role;
  return { role, isAdmin: role === "owner" || role === "admin" };
}
