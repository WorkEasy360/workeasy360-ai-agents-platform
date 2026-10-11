"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button, Card, FormError, Hint } from "@/components/ui";
import { CopyBox, errorMessage } from "@/components/app/misc";
import { api } from "@/lib/api";

/** Signing secret for async-run callbacks. Hidden until revealed; can be rotated. */
export function WebhookSecretCard() {
  const [secret, setSecret] = useState<string | null>(null);
  const reveal = useMutation({
    mutationFn: () => api<{ secret: string }>("/api/v1/api-keys/webhook-secret"),
    onSuccess: (d) => setSecret(d.secret),
  });
  const rotate = useMutation({
    mutationFn: () => api<{ secret: string }>("/api/v1/api-keys/webhook-secret/rotate", { method: "POST" }),
    onSuccess: (d) => setSecret(d.secret),
  });

  return (
    <Card className="space-y-3">
      <h2 className="font-medium">Webhook signing secret</h2>
      <p className="text-sm text-[var(--muted)]">
        When you start a run with <code>&quot;async&quot;: true</code> and a <code>callbackUrl</code>, we POST the result to that URL with an{" "}
        <code>X-WE360-Signature: t=…,v1=…</code> header. Verify it with HMAC-SHA256 of <code>&quot;t.body&quot;</code> using this secret.
      </p>
      {secret ? (
        <CopyBox value={secret} />
      ) : (
        <Button variant="secondary" onClick={() => reveal.mutate()} disabled={reveal.isPending}>
          Reveal secret
        </Button>
      )}
      {secret && (
        <div>
          <Button variant="ghost" size="sm" onClick={() => confirm("Rotate the secret? Signatures made with the old one will stop verifying immediately.") && rotate.mutate()} disabled={rotate.isPending}>
            Rotate secret
          </Button>
          <Hint>Rotate it if it may have leaked.</Hint>
        </div>
      )}
      <FormError message={errorMessage(reveal.error ?? rotate.error)} />
    </Card>
  );
}
