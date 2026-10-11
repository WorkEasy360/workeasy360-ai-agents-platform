"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

export interface Me {
  user: {
    id: string;
    name: string;
    email: string;
    image: string | null;
    emailVerified: boolean;
    twoFactorEnabled: boolean;
    platformRole: "super_admin" | "support" | null;
  };
  activeOrganizationId: string | null;
  organizations: Array<{
    id: string;
    name: string;
    slug: string;
    logo: string | null;
    planKey: string;
    status: string;
    role: "owner" | "admin" | "member";
  }>;
}

export function useMe() {
  return useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/api/v1/me") });
}
