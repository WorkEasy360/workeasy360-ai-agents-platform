"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { Button, Card, FormError, Input, Label, Notice } from "@/components/ui";
import { authClient } from "@/lib/auth-client";

const MIN_LENGTH = 10;

/** Landing page for the reset link: /reset-password?token=… (or ?error=INVALID_TOKEN if it expired). */
export default function ResetPasswordPage() {
  return (
    <Suspense fallback={<Card>Loading…</Card>}>
      <ResetPasswordForm />
    </Suspense>
  );
}

function ResetPasswordForm() {
  const params = useSearchParams();
  // Read once, then drop the token from the address bar so it doesn't stay in browser history.
  const [token] = useState(() => params.get("token"));
  const linkError = params.get("error");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (params.get("token")) window.history.replaceState(null, "", "/reset-password");
  }, [params]);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const password = String(form.get("password"));
    if (password.length < MIN_LENGTH) return setError(`Use at least ${MIN_LENGTH} characters.`);
    if (password !== String(form.get("confirm"))) return setError("The passwords don't match.");
    setPending(true);
    setError(null);
    const { error } = await authClient.resetPassword({ newPassword: password, token: token! });
    setPending(false);
    if (error) {
      return setError(
        error.code === "INVALID_TOKEN" || error.status === 400
          ? "This reset link has expired or was already used. Request a new one."
          : (error.message ?? "Couldn't reset the password. Please try again."),
      );
    }
    setDone(true);
  }

  if (done) {
    return (
      <Card className="space-y-4">
        <h1 className="text-xl font-semibold">Password updated</h1>
        <Notice tone="success">Your password has been changed. For your security, you&apos;ve been signed out on other devices.</Notice>
        <Link href="/login">
          <Button className="w-full">Sign in</Button>
        </Link>
      </Card>
    );
  }

  if (!token || linkError) {
    return (
      <Card className="space-y-4">
        <h1 className="text-xl font-semibold">Link expired</h1>
        <p className="text-sm text-[var(--muted)]">This reset link is invalid, expired or was already used. Links work once and expire after 1 hour.</p>
        <Link href="/forgot-password">
          <Button className="w-full">Send a new link</Button>
        </Link>
      </Card>
    );
  }

  return (
    <Card>
      <h1 className="mb-1 text-xl font-semibold">Choose a new password</h1>
      <p className="mb-6 text-sm text-[var(--muted)]">At least {MIN_LENGTH} characters.</p>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <Label htmlFor="password">New password</Label>
          <Input id="password" name="password" type="password" autoComplete="new-password" minLength={MIN_LENGTH} required autoFocus />
        </div>
        <div>
          <Label htmlFor="confirm">Confirm new password</Label>
          <Input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={MIN_LENGTH} required />
        </div>
        <FormError message={error} />
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "Saving…" : "Set new password"}
        </Button>
      </form>
    </Card>
  );
}
