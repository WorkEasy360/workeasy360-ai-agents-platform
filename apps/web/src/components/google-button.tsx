"use client";

import { Button } from "@/components/ui";
import { authClient } from "@/lib/auth-client";

/** Hidden until Google OAuth credentials are configured (NEXT_PUBLIC_GOOGLE_LOGIN=true). */
export function GoogleButton() {
  if (process.env.NEXT_PUBLIC_GOOGLE_LOGIN !== "true") return null;
  return (
    <Button
      type="button"
      variant="secondary"
      className="mt-3 w-full"
      onClick={() => authClient.signIn.social({ provider: "google", callbackURL: "/" })}
    >
      Continue with Google
    </Button>
  );
}
