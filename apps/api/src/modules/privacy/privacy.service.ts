import { createHash } from "node:crypto";
import { asc, eq, inArray, type SQL } from "drizzle-orm";
import type { Tx } from "@we360/db";
import { conversations, executions, messages } from "@we360/db/schema";

/** Allowed values for an organization's conversation retention, in days. */
export const RETENTION_OPTIONS = [30, 90, 180, 365] as const;

/**
 * Deletes conversations matching `where` (inside a tenant transaction), with everything that
 * holds their text: messages (cascade), executions and their steps (previews, tool I/O).
 * Usage records stay: they hold token counts and cost only.
 */
export async function eraseConversations(tx: Tx, where: SQL): Promise<{ conversations: number; executions: number }> {
  const ids = (await tx.select({ id: conversations.id }).from(conversations).where(where)).map((r) => r.id);
  if (!ids.length) return { conversations: 0, executions: 0 };
  let execCount = 0;
  let convCount = 0;
  // Batches keep statements small for end users with many conversations.
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    execCount += (await tx.delete(executions).where(inArray(executions.conversationId, batch)).returning({ id: executions.id })).length;
    convCount += (await tx.delete(conversations).where(inArray(conversations.id, batch)).returning({ id: conversations.id })).length;
  }
  return { conversations: convCount, executions: execCount };
}

/** Everything stored for one end user, for access requests (DPDP / GDPR). */
export async function exportEndUser(tx: Tx, endUserRef: string) {
  const convs = await tx
    .select({ id: conversations.id, agentId: conversations.agentId, channel: conversations.channel, title: conversations.title, createdAt: conversations.createdAt, lastMessageAt: conversations.lastMessageAt })
    .from(conversations)
    .where(eq(conversations.endUserRef, endUserRef))
    .orderBy(asc(conversations.createdAt));
  const out = [];
  for (const c of convs) {
    const msgs = await tx
      .select({ role: messages.role, content: messages.content, createdAt: messages.createdAt })
      .from(messages)
      .where(eq(messages.conversationId, c.id))
      .orderBy(asc(messages.createdAt));
    out.push({ ...c, messages: msgs });
  }
  return out;
}

/**
 * Audit entries must not store the end-user reference itself (it may be an email address),
 * only a short fingerprint so a later request for the same person can be matched.
 */
export function refFingerprint(endUserRef: string): string {
  return createHash("sha256").update(endUserRef).digest("hex").slice(0, 12);
}
