import { Router } from "express";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { appDb, withTenant } from "@we360/db";
import { conversations, organization } from "@we360/db/schema";
import { audit, parse, tenantOf } from "../../lib/http";
import { requireRole, requireSession, requireTenant } from "../../middleware/auth";
import { RETENTION_OPTIONS, eraseConversations, exportEndUser, refFingerprint } from "./privacy.service";

/**
 * Privacy controls for the organization (the data controller for its end users' chats):
 * conversation retention, and access / erasure requests for one end user.
 * End-user references go in the request body, never the URL, so they stay out of access logs.
 */
export const privacyRouter = Router();
privacyRouter.use(requireSession, requireTenant);

privacyRouter.get("/settings", async (req, res) => {
  const { orgId } = tenantOf(req);
  const [row] = await appDb()
    .select({ conversationRetentionDays: organization.conversationRetentionDays })
    .from(organization)
    .where(eq(organization.id, orgId));
  res.json({ ...row, retentionOptions: RETENTION_OPTIONS });
});

const retentionSchema = z.object({
  conversationRetentionDays: z.number().int().refine((n) => (RETENTION_OPTIONS as readonly number[]).includes(n), "Choose 30, 90, 180 or 365 days."),
});

privacyRouter.patch("/settings", requireRole("owner"), async (req, res) => {
  const { orgId } = tenantOf(req);
  const body = parse(retentionSchema, req.body);
  const [before] = await appDb().select({ days: organization.conversationRetentionDays }).from(organization).where(eq(organization.id, orgId));
  await appDb().update(organization).set({ conversationRetentionDays: body.conversationRetentionDays }).where(eq(organization.id, orgId));
  await audit(req, {
    action: "privacy.retention_changed",
    targetType: "organization",
    targetId: orgId,
    diff: { before: before?.days, after: body.conversationRetentionDays },
  });
  res.json(body);
});

const endUserSchema = z.object({ endUserRef: z.string().trim().min(1).max(200) });

/** How much is stored for an end user, so an admin can check before exporting or erasing. */
privacyRouter.post("/end-users/lookup", requireRole("admin"), async (req, res) => {
  const { orgId } = tenantOf(req);
  const { endUserRef } = parse(endUserSchema, req.body);
  const [row] = await withTenant(orgId, (tx) =>
    tx
      .select({
        conversations: sql<number>`count(*)::int`,
        // Qualified by hand: in a single-table select Drizzle renders columns unqualified.
        messages: sql<number>`coalesce(sum((select count(*) from messages m where m.conversation_id = "conversations"."id")), 0)::int`,
        firstAt: sql<string | null>`min(${conversations.createdAt})`,
        lastAt: sql<string | null>`max(coalesce(${conversations.lastMessageAt}, ${conversations.createdAt}))`,
      })
      .from(conversations)
      .where(eq(conversations.endUserRef, endUserRef)),
  );
  res.json(row);
});

/** Access request: a JSON copy of everything stored for one end user. */
privacyRouter.post("/end-users/export", requireRole("admin"), async (req, res) => {
  const { orgId } = tenantOf(req);
  const { endUserRef } = parse(endUserSchema, req.body);
  const data = await withTenant(orgId, async (tx) => {
    const rows = await exportEndUser(tx, endUserRef);
    await audit(req, { action: "privacy.end_user_exported", targetType: "end_user", targetId: refFingerprint(endUserRef), diff: { conversations: rows.length } }, tx);
    return rows;
  });
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-disposition", `attachment; filename="end-user-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json({ exportedAt: new Date().toISOString(), endUserRef, conversations: data });
});

/** Erasure request: deletes every conversation, message and run log for one end user. */
privacyRouter.post("/end-users/erase", requireRole("admin"), async (req, res) => {
  const { orgId } = tenantOf(req);
  const { endUserRef } = parse(endUserSchema, req.body);
  const result = await withTenant(orgId, async (tx) => {
    const erased = await eraseConversations(tx, eq(conversations.endUserRef, endUserRef));
    await audit(req, { action: "privacy.end_user_erased", targetType: "end_user", targetId: refFingerprint(endUserRef), diff: erased }, tx);
    return erased;
  });
  res.json(result);
});
