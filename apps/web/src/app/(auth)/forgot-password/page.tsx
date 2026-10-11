"use client";

import Link from "next/link";
import { useState } from "react";
import { Button, Card, FormError, Input, Label, Notice } from "@/components/ui";
import { authClient } from "@/lib/auth-client";
import { usePlatform } from "@/lib/use-platform";

export default function ForgotPasswordPage() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const { data: platform } = usePlatform();

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email")).trim();
    setPending(true);
    setError(null);
    const { error } = await authClient.requestPasswordReset({
      email,
      redirectTo: `${window.location.origin}/reset-password`,
    });
    setPending(false);
    // Rate limits and server errors are real failures; an unknown email is not reported,
    // so this page can't be used to find out who has an account.
    if (error && error.status !== 404) return setError(error.message ?? "Couldn't send the email. Please try again.");
    setSentTo(email);
  }

  return (
    <Card>
      <h1 className="mb-1 text-xl font-semibold">Reset your password</h1>
      {platform && !platform.emailEnabled ? (
        <div className="mt-4">
          <Notice>Email isn&apos;t set up on this server yet, so reset links can&apos;t be sent. Ask a platform administrator to create a reset link for you.</Notice>
        </div>
      ) : sentTo ? (
        <div className="mt-4 space-y-4">
          <Notice tone="success">
            If an account exists for <strong>{sentTo}</strong>, we&apos;ve sent a link to reset the password. It works once and expires in 1 hour.
          </Notice>
          <p className="text-sm text-[var(--muted)]">Didn&apos;t get it? Check your spam folder, or try again in a minute.</p>
        </div>
      ) : (
        <>
          <p className="mb-6 text-sm text-[var(--muted)]">Enter your account email and we&apos;ll send you a reset link.</p>
          <form onSubmit={onSubmit} className="space-y-4">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" autoComplete="email" required autoFocus />
            </div>
            <FormError message={error} />
            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? "Sending…" : "Send reset link"}
            </Button>
          </form>
        </>
      )}
      <p className="mt-6 text-center text-sm text-[var(--muted)]">
        <Link href="/login" className="font-medium text-brand-600 hover:underline">
          Back to sign in
        </Link>
      </p>
    </Card>
  );
}
