"use client";

import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, FormError } from "@/components/ui";
import { setActiveOrgId } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

export default function AcceptInvitationPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { data: session, isPending } = authClient.useSession();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function accept() {
    setBusy(true);
    setError(null);
    const { data, error } = await authClient.organization.acceptInvitation({ invitationId: id });
    setBusy(false);
    if (error || !data) return setError(error?.message ?? "This invitation is no longer valid.");
    setActiveOrgId(data.member.organizationId);
    await queryClient.invalidateQueries({ queryKey: ["me"] });
    router.push("/");
  }

  if (isPending) return <Card>Loading…</Card>;

  if (!session) {
    return (
      <Card>
        <h1 className="mb-2 text-xl font-semibold">You've been invited</h1>
        <p className="mb-6 text-sm text-[var(--muted)]">
          Sign in or create an account with the email address the invitation was sent to, then open the link again.
        </p>
        <div className="flex gap-3">
          <Link href="/login" className="flex-1">
            <Button className="w-full">Sign in</Button>
          </Link>
          <Link href="/signup" className="flex-1">
            <Button variant="secondary" className="w-full">
              Create account
            </Button>
          </Link>
        </div>
      </Card>
    );
  }

  return (
    <Card>
      <h1 className="mb-2 text-xl font-semibold">Join the organization</h1>
      <p className="mb-6 text-sm text-[var(--muted)]">Signed in as {session.user.email}.</p>
      <FormError message={error} />
      <Button className="mt-4 w-full" onClick={accept} disabled={busy}>
        {busy ? "Joining…" : "Accept invitation"}
      </Button>
    </Card>
  );
}
