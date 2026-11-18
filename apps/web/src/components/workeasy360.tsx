"use client";

import { Button } from "@/components/ui";

/**
 * "Continue with WorkEasy360": a plain navigation to the API, which keeps the sign-in's state server-side
 * and redirects to WorkEasy360 Accounts (docs/workeasy360-sso.md). Never started automatically.
 */
export function Workeasy360Button({ primary = false }: { primary?: boolean }) {
  return (
    <Button
      type="button"
      variant={primary ? "primary" : "secondary"}
      className="mt-3 w-full"
      onClick={() => {
        window.location.assign("/api/auth/workeasy360/start");
      }}
    >
      Continue with WorkEasy360
    </Button>
  );
}

/** Why a WorkEasy360 sign-in did not complete (`/login?sso_error=<code>[&reason=]`), in words. */
export function workeasy360ErrorMessage(code: string | null, reason: string | null): string | null {
  if (!code) return null;
  const messages: Record<string, string> = {
    not_configured: "Sign-in with WorkEasy360 is not available here.",
    expired: "That sign-in took too long or was already used. Please try again.",
    unavailable: "WorkEasy360 could not be reached. Please try again in a moment.",
    rate_limited: "Too many sign-ins right now. Please wait a minute and try again.",
    cancelled: "Sign-in was cancelled.",
    refused: "WorkEasy360 did not complete the sign-in. Please try again.",
    invalid_token: "WorkEasy360's answer could not be verified. Please try again, or contact support if it keeps happening.",
    wrong_product: "That sign-in was for another WorkEasy360 product.",
    no_organization: "Choose an organization in WorkEasy360 to use Agents.",
    email_unverified: "Verify your email address in WorkEasy360 first.",
    wrong_organization: "WorkEasy360 signed you in to a different organization than the one you chose. Please try again.",
    not_entitled:
      reason === "expired"
        ? "Your organization's WorkEasy360 Agents subscription has expired. Renew it in WorkEasy360."
        : reason === "suspended"
          ? "Your organization's access to WorkEasy360 Agents is suspended. Contact your administrator."
          : reason === "membership_inactive"
            ? "Your access to this organization has ended. Ask an administrator."
            : reason === "no_seat"
              ? "Ask an administrator for a WorkEasy360 Agents seat."
              : "Your organization doesn't have WorkEasy360 Agents yet. Get it in WorkEasy360.",
    membership_inactive: "Your access to this organization has ended. Ask an administrator.",
    organization_inactive: "This organization is not active in WorkEasy360.",
    integration_suspended: "Sign-in with WorkEasy360 is suspended for Agents. Contact support.",
    access_policy_denied: "Your organization's sign-in policy does not allow this sign-in.",
    access_unverified: "Agents cannot confirm your access with WorkEasy360 right now. Try again in a few minutes.",
    tenant_suspended: "This organization is suspended in Agents. Contact support.",
    no_tenant: "Your organization has not been set up in Agents yet. Contact support.",
    identity_conflict: "Your WorkEasy360 account needs to be moved to the new sign-in. Contact support.",
    account_exists:
      "An Agents account already uses this email address. Sign in with your password, or ask support to connect it to your WorkEasy360 account.",
    account_suspended: "This account has been suspended.",
  };
  return messages[code] ?? "Sign-in with WorkEasy360 did not complete. Please try again.";
}
