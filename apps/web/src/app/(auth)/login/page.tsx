"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, FormError, Input, Label } from "@/components/ui";
import { GoogleButton } from "@/components/google-button";
import { authClient } from "@/lib/auth-client";

export default function LoginPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // Set when the account has two-factor authentication: ask for the app code next.
  const [needsCode, setNeedsCode] = useState(false);
  const [useBackup, setUseBackup] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setPending(true);
    setError(null);
    const { data, error } = await authClient.signIn.email({
      email: String(form.get("email")),
      password: String(form.get("password")),
    });
    setPending(false);
    if (error) return setError(error.message ?? "Couldn't sign in. Check your email and password.");
    if (data && "twoFactorRedirect" in data && data.twoFactorRedirect) return setNeedsCode(true);
    router.push("/");
  }

  async function onCode(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get("code")).trim();
    setPending(true);
    setError(null);
    const { error } = useBackup
      ? await authClient.twoFactor.verifyBackupCode({ code })
      : await authClient.twoFactor.verifyTotp({ code, trustDevice: true });
    setPending(false);
    if (error) return setError("That code didn't work. Try again.");
    router.push("/");
  }

  if (needsCode) {
    return (
      <Card>
        <h1 className="mb-1 text-xl font-semibold">Two-step verification</h1>
        <p className="mb-6 text-sm text-[var(--muted)]">
          {useBackup ? "Enter one of your backup codes." : "Enter the 6-digit code from your authenticator app."}
        </p>
        <form onSubmit={onCode} className="space-y-4">
          <div>
            <Label htmlFor="code">{useBackup ? "Backup code" : "Code"}</Label>
            <Input id="code" name="code" inputMode={useBackup ? "text" : "numeric"} autoComplete="one-time-code" autoFocus required className="font-mono" />
          </div>
          <FormError message={error} />
          <Button type="submit" className="w-full" disabled={pending}>
            {pending ? "Checking…" : "Verify"}
          </Button>
        </form>
        <button className="mt-4 text-sm text-brand-600 hover:underline" onClick={() => setUseBackup(!useBackup)}>
          {useBackup ? "Use authenticator app instead" : "Lost your phone? Use a backup code"}
        </button>
      </Card>
    );
  }

  return (
    <Card>
      <h1 className="mb-1 text-xl font-semibold">Sign in</h1>
      <p className="mb-6 text-sm text-[var(--muted)]">Welcome back.</p>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <Label htmlFor="email">Email</Label>
          <Input id="email" name="email" type="email" autoComplete="email" required />
        </div>
        <div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <Label htmlFor="password" className="mb-0">
              Password
            </Label>
            <Link href="/forgot-password" className="text-xs text-brand-600 hover:underline">
              Forgot password?
            </Link>
          </div>
          <Input id="password" name="password" type="password" autoComplete="current-password" required />
        </div>
        <FormError message={error} />
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <GoogleButton />
      <p className="mt-6 text-center text-sm text-[var(--muted)]">
        New here?{" "}
        <Link href="/signup" className="font-medium text-brand-600 hover:underline">
          Create an account
        </Link>
      </p>
    </Card>
  );
}
