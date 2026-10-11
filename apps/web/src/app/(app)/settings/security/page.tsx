"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { useState } from "react";
import { ShieldCheck, Trash2 } from "lucide-react";
import { Badge, Button, Card, Field, FormError, Input, Notice } from "@/components/ui";
import { api } from "@/lib/api";
import { authClient } from "@/lib/auth-client";
import { useMe } from "@/lib/use-me";

type Step = { kind: "idle" } | { kind: "scan"; qr: string; secret: string; backupCodes: string[] } | { kind: "done"; backupCodes: string[] };

/** Two-factor authentication (authenticator app). Required for platform staff in production. */
export default function SecurityPage() {
  const { data: me } = useMe();
  const queryClient = useQueryClient();
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const enabled = me?.user.twoFactorEnabled;

  async function start(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data, error } = await authClient.twoFactor.enable({ password });
    setBusy(false);
    if (error || !data) return setError(error?.message ?? "Couldn't start setup. Check your password.");
    if (data.method !== "totp") return setError("Authenticator app setup isn't available.");
    const secret = new URL(data.totpURI).searchParams.get("secret") ?? "";
    setStep({ kind: "scan", qr: await QRCode.toDataURL(data.totpURI, { margin: 1, width: 200 }), secret, backupCodes: data.backupCodes });
    setPassword("");
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    if (step.kind !== "scan") return;
    setBusy(true);
    setError(null);
    const { error } = await authClient.twoFactor.verifyTotp({ code: code.trim() });
    setBusy(false);
    if (error) return setError("That code didn't match. Check the time on your phone and try again.");
    setStep({ kind: "done", backupCodes: step.backupCodes });
    setCode("");
    queryClient.invalidateQueries({ queryKey: ["me"] });
  }

  async function disable(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await authClient.twoFactor.disable({ password });
    setBusy(false);
    if (error) return setError(error.message ?? "Couldn't turn off two-factor authentication.");
    setPassword("");
    queryClient.invalidateQueries({ queryKey: ["me"] });
  }

  return (
    <div className="max-w-xl space-y-6">
      <Card className="space-y-5">
        <div className="flex items-center gap-3">
          <ShieldCheck className="size-5 text-brand-600" aria-hidden />
          <h2 className="flex-1 font-medium">Two-factor authentication</h2>
          {enabled ? <Badge tone="green">On</Badge> : <Badge>Off</Badge>}
        </div>
        <p className="text-sm text-[var(--muted)]">
          Ask for a code from an authenticator app (Google Authenticator, Microsoft Authenticator, 1Password…) when you sign in.
        </p>
        {me?.user.platformRole && !enabled && <Notice tone="warning">Platform staff must turn this on to use the admin dashboard.</Notice>}

        {step.kind === "done" && (
          <Notice tone="success">
            <p className="font-medium">Two-factor authentication is on.</p>
            <p className="mt-1">Save these backup codes somewhere safe. Each works once if you lose your phone:</p>
            <pre className="mt-2 grid grid-cols-2 gap-1 font-mono text-xs">{step.backupCodes.join("\n")}</pre>
          </Notice>
        )}

        {step.kind === "scan" && (
          <form onSubmit={confirm} className="space-y-4">
            <p className="text-sm">1. Scan this QR code with your authenticator app.</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={step.qr} alt="QR code for your authenticator app" className="size-48 rounded border border-[var(--border)] bg-white p-1" />
            <p className="text-xs text-[var(--muted)]">
              Can&apos;t scan? Enter this key manually: <code className="break-all">{step.secret}</code>
            </p>
            <Field label="2. Enter the 6-digit code from the app" htmlFor="totp">
              <Input id="totp" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} className="w-40 font-mono" />
            </Field>
            <FormError message={error} />
            <Button type="submit" disabled={busy || code.trim().length < 6}>
              {busy ? "Checking…" : "Turn on"}
            </Button>
          </form>
        )}

        {step.kind === "idle" && !enabled && (
          <form onSubmit={start} className="space-y-4">
            <Field label="Confirm your password" htmlFor="pw">
              <Input id="pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            <FormError message={error} />
            <Button type="submit" disabled={busy || !password}>
              {busy ? "Starting…" : "Set up"}
            </Button>
          </form>
        )}

        {enabled && step.kind !== "done" && (
          <form onSubmit={disable} className="space-y-4 border-t border-[var(--border)] pt-4">
            <Field label="Password (to turn off)" htmlFor="pw-off">
              <Input id="pw-off" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
            <FormError message={error} />
            <Button type="submit" variant="secondary" disabled={busy || !password}>
              Turn off
            </Button>
          </form>
        )}
      </Card>
      <DeleteAccount />
    </div>
  );
}

interface DeletionPlan {
  soloOrganizations: Array<{ id: string; name: string }>;
  blockingOrganizations: Array<{ id: string; name: string }>;
}

/** Self-service account deletion (right to erasure). */
function DeleteAccount() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: plan } = useQuery({ queryKey: ["account-deletion"], queryFn: () => api<DeletionPlan>("/api/v1/me/account-deletion"), enabled: open });
  const { data: hasPassword } = useQuery({
    queryKey: ["has-password"],
    queryFn: async () => (await authClient.listAccounts()).data?.some((a) => a.providerId === "credential") ?? false,
    enabled: open,
  });

  async function remove(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await authClient.deleteUser(hasPassword ? { password } : {});
    setBusy(false);
    if (error) {
      return setError(
        error.code === "SESSION_EXPIRED"
          ? "For your security, sign out and sign in again, then delete your account within a day."
          : error.code === "INVALID_PASSWORD"
            ? "That password isn't right."
            : (error.message ?? "Couldn't delete your account."),
      );
    }
    queryClient.clear();
    router.replace("/login");
  }

  const blocked = (plan?.blockingOrganizations.length ?? 0) > 0;
  return (
    <Card className="space-y-4">
      <div className="flex items-center gap-3">
        <Trash2 className="size-5 text-red-600" aria-hidden />
        <h2 className="flex-1 font-medium">Delete my account</h2>
      </div>
      <p className="text-sm text-[var(--muted)]">
        Permanently deletes your profile, sign-in methods and memberships. Agents and documents you created in shared organizations stay with that organization.
      </p>
      {!open ? (
        <Button variant="secondary" className="text-red-600" onClick={() => setOpen(true)}>
          Delete my account…
        </Button>
      ) : !plan ? null : blocked ? (
        <Notice tone="warning">
          You&apos;re the only owner of {plan.blockingOrganizations.map((o) => o.name).join(", ")}, which other people use. In Settings → Members, make someone else an
          owner (or delete the organization) first.
        </Notice>
      ) : (
        <form onSubmit={remove} className="space-y-4 border-t border-[var(--border)] pt-4">
          {plan.soloOrganizations.length > 0 && (
            <Notice tone="warning">
              These organizations have no other members and will be deleted with everything in them (agents, documents, conversations):{" "}
              <span className="font-medium">{plan.soloOrganizations.map((o) => o.name).join(", ")}</span>. Download an export from Settings → Organization first if you need one.
            </Notice>
          )}
          {hasPassword && (
            <Field label="Your password" htmlFor="del-pw">
              <Input id="del-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            </Field>
          )}
          <Field label='Type "delete my account" to confirm' htmlFor="del-confirm">
            <Input id="del-confirm" value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" />
          </Field>
          <FormError message={error} />
          <div className="flex gap-2">
            <Button type="submit" variant="danger" disabled={busy || confirmText.trim().toLowerCase() !== "delete my account" || (hasPassword && !password)}>
              {busy ? "Deleting…" : "Delete permanently"}
            </Button>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
