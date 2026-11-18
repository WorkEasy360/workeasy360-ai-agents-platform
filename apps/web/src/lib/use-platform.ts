"use client";

import { useQuery } from "@tanstack/react-query";

/** Server settings that change what the sign-in and members pages offer (GET /api/public/v1/platform). */
export interface PlatformSettings {
  /** false when SES isn't configured: no verification, reset or invitation emails are sent. */
  emailEnabled: boolean;
  /** false when only invited email addresses can create an account. */
  signupOpen: boolean;
  /** "Continue with WorkEasy360" is offered (docs/workeasy360-sso.md). */
  workeasy360?: boolean;
  /** WorkEasy360 is the only way in: no password or Google sign-in, no sign-up. */
  ssoOnly?: boolean;
}

export function usePlatform() {
  return useQuery({
    queryKey: ["platform"],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const res = await fetch("/api/public/v1/platform");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as PlatformSettings;
    },
  });
}
