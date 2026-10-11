import { createHmac, randomBytes } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { withTenant } from "@we360/db";
import { credentials } from "@we360/db/schema";
import { decryptSecret, encryptSecret } from "../../lib/crypto";
import { logger } from "../../lib/logger";
import { safeFetch } from "../../lib/safe-fetch";

const INTEGRATION_KEY = "webhook.signing";

/** Returns the org's webhook signing secret, creating it on first use. Stored encrypted like any credential. */
export async function getWebhookSecret(orgId: string, createdBy?: string): Promise<string> {
  const existing = await withTenant(orgId, async (tx) => {
    const [row] = await tx
      .select()
      .from(credentials)
      .where(and(eq(credentials.integrationKey, INTEGRATION_KEY), isNull(credentials.deletedAt)))
      // If two first-time requests raced and both created one, everyone uses the oldest.
      .orderBy(asc(credentials.createdAt))
      .limit(1);
    return row;
  });
  if (existing) return decryptSecret(existing);

  const secret = `whsec_${randomBytes(24).toString("base64url")}`;
  const enc = await encryptSecret(secret);
  await withTenant(orgId, (tx) =>
    tx.insert(credentials).values({ orgId, integrationKey: INTEGRATION_KEY, name: "Webhook signing secret", authType: "hmac", ...enc, createdBy }),
  );
  // Re-read so a concurrent creator and we agree on the same (oldest) secret.
  return getWebhookSecret(orgId, createdBy);
}

/** Replaces the signing secret (old signatures stop verifying immediately). */
export async function rotateWebhookSecret(orgId: string, createdBy?: string): Promise<string> {
  await withTenant(orgId, (tx) =>
    tx
      .update(credentials)
      .set({ deletedAt: new Date() })
      .where(and(eq(credentials.integrationKey, INTEGRATION_KEY), isNull(credentials.deletedAt))),
  );
  return getWebhookSecret(orgId, createdBy);
}

/**
 * Signature header: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">`.
 * Receivers should recompute it and reject timestamps older than ~5 minutes.
 */
export function signPayload(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

/** Delivers a webhook through the SSRF-safe client, retrying a few times on failure. */
export async function deliverWebhook(orgId: string, url: string, payload: unknown): Promise<{ delivered: boolean; attempts: number; lastStatus?: number }> {
  const secret = await getWebhookSecret(orgId);
  const body = JSON.stringify(payload);
  let lastStatus: number | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await safeFetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-we360-signature": signPayload(secret, body) },
        body,
        timeoutMs: 10_000,
        maxBytes: 10_000,
      });
      lastStatus = res.status;
      if (res.status >= 200 && res.status < 300) return { delivered: true, attempts: attempt, lastStatus };
    } catch (err) {
      logger.warn({ err: (err as Error).message, host: hostOf(url), attempt }, "webhook delivery failed");
    }
    await new Promise((r) => setTimeout(r, attempt * 2_000));
  }
  return { delivered: false, attempts: 3, lastStatus };
}

/** Callback URLs may embed customer tokens; log only the host. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "invalid-url";
  }
}
