"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Card, FormError, Input, Label } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

/** The admin API's answer to a WorkEasy360 session that has not presented Agents' own second factor yet. */
export function isStepUpRequired(error: unknown): boolean {
  return error instanceof ApiError && error.code === "two_factor_step_up_required";
}

/**
 * The admin step-up of a WorkEasy360 session (docs/workeasy360-sso.md, "Admin dashboard: Agents' own second
 * factor"): WorkEasy360 has no MFA, so this session presents the account's own TOTP or a backup code once. Better
 * Auth checks it with the current session (no new session); then every admin query is asked again.
 */
export function StepUpPrompt() {
  const queryClient = useQueryClient();
  const [useBackup, setUseBackup] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code")).trim();
    setPending(true);
    setError(null);
    const { error: failed } = useBackup ? await authClient.twoFactor.verifyBackupCode({ code }) : await authClient.twoFactor.verifyTotp({ code });
    setPending(false);
    if (failed) return setError(failed.status === 429 ? "Too many attempts. Try again in a few minutes." : "That code didn't work. Try again.");
    await queryClient.invalidateQueries();
  }

  return (
    <Card className="max-w-md p-6">
      <h2 className="mb-1 text-base font-semibold">Two-step verification</h2>
      <p className="mb-4 text-sm text-[var(--muted)]">
        You signed in with WorkEasy360. To use the admin dashboard, {useBackup ? "enter one of your backup codes." : "enter the 6-digit code from your authenticator app."}
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <Label htmlFor="step-up-code">{useBackup ? "Backup code" : "Code"}</Label>
          <Input id="step-up-code" name="code" inputMode={useBackup ? "text" : "numeric"} autoComplete="one-time-code" autoFocus required className="font-mono" />
        </div>
        <FormError message={error} />
        <div className="flex items-center justify-between gap-3">
          <Button type="submit" disabled={pending}>
            {pending ? "Checking…" : "Verify"}
          </Button>
          <button type="button" className="text-sm text-[var(--muted)] hover:text-[var(--foreground)]" onClick={() => setUseBackup((b) => !b)}>
            {useBackup ? "Use the authenticator app" : "Use a backup code"}
          </button>
        </div>
      </form>
    </Card>
  );
}
