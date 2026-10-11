"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, Card, FormError, Input, Label } from "@/components/ui";
import { setActiveOrgId } from "@/lib/api";
import { authClient } from "@/lib/auth-client";

function slugify(name: string) {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  // Suffix keeps slugs unique without a round trip; users never see it in the UI.
  return `${base || "org"}-${Math.random().toString(36).slice(2, 7)}`;
}

export default function OnboardingPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const name = String(new FormData(e.currentTarget).get("name")).trim();
    setPending(true);
    setError(null);
    const { data, error } = await authClient.organization.create({ name, slug: slugify(name) });
    setPending(false);
    if (error || !data) return setError(error?.message ?? "Couldn't create the organization.");
    setActiveOrgId(data.id);
    await queryClient.invalidateQueries({ queryKey: ["me"] });
    router.push("/");
  }

  return (
    <Card>
      <h1 className="mb-1 text-xl font-semibold">Name your organization</h1>
      <p className="mb-6 text-sm text-[var(--muted)]">
        Usually your company or team name. You can invite teammates next.
      </p>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <Label htmlFor="name">Organization name</Label>
          <Input id="name" name="name" placeholder="Acme Corp" maxLength={80} required />
        </div>
        <FormError message={error} />
        <Button type="submit" className="w-full" disabled={pending}>
          {pending ? "Creating…" : "Continue"}
        </Button>
      </form>
    </Card>
  );
}
