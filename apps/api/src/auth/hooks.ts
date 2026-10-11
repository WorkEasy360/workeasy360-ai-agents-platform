import { APIError } from "better-auth/api";
import { and, count, eq, gt, inArray, sql } from "drizzle-orm";
import { adminDb, appDb, withTenant } from "@we360/db";
import { auditLogs, invitation, member, organization, user, workspaces } from "@we360/db/schema";
import { createHash } from "node:crypto";
import { enqueueOrgCleanup, redis } from "../lib/queue";
import { getOrgLimits } from "../modules/plans/plan-limits";

/** Members plus pending invitations must stay within the plan's member limit. */
export async function assertSeatAvailable(orgId: string): Promise<void> {
  const { members: limit } = await getOrgLimits(orgId);
  if (limit === null) return;
  const db = appDb();
  const [[members], [pending]] = await Promise.all([
    db.select({ n: count() }).from(member).where(eq(member.organizationId, orgId)),
    db
      .select({ n: count() })
      .from(invitation)
      .where(
        and(eq(invitation.organizationId, orgId), eq(invitation.status, "pending"), gt(invitation.expiresAt, new Date())),
      ),
  ]);
  if ((members?.n ?? 0) + (pending?.n ?? 0) >= limit) {
    throw new APIError("FORBIDDEN", {
      message: `Your plan allows ${limit} member${limit === 1 ? "" : "s"}. Upgrade to invite more people.`,
      code: "plan_limit_reached",
    });
  }
}

/**
 * Every organization starts with one default workspace. The multi-workspace UI ships in v1.1,
 * but all resources are workspace-scoped from day one.
 */
export async function onOrganizationCreated(orgId: string, userId: string): Promise<void> {
  await withTenant(orgId, async (tx) => {
    const [ws] = await tx
      .insert(workspaces)
      .values({ orgId, name: "Default", slug: "default", createdBy: userId })
      .returning({ id: workspaces.id });
    await tx.insert(auditLogs).values({
      orgId,
      actorType: "user",
      actorId: userId,
      action: "organization.created",
      targetType: "workspace",
      targetId: ws!.id,
    });
  });
}

export interface AccountDeletionPlan {
  /** Organizations this user owns alone: deleted with the account. */
  soloOrganizations: Array<{ id: string; name: string }>;
  /** Organizations with other members that this user owns: deletion is blocked until ownership moves. */
  blockingOrganizations: Array<{ id: string; name: string }>;
}

/** What deleting this user's account would do to the organizations they own. */
export async function planAccountDeletion(userId: string): Promise<AccountDeletionPlan> {
  const owned = await adminDb()
    .select({
      id: organization.id,
      name: organization.name,
      members: sql<number>`(select count(*) from member m where m.organization_id = ${organization.id})::int`,
      owners: sql<number>`(select count(*) from member m where m.organization_id = ${organization.id} and m.role = 'owner')::int`,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(and(eq(member.userId, userId), eq(member.role, "owner")));
  return {
    soloOrganizations: owned.filter((o) => o.members === 1).map(({ id, name }) => ({ id, name })),
    // Shared organizations need another owner, or they'd be left with nobody who can manage them.
    blockingOrganizations: owned.filter((o) => o.members > 1 && o.owners === 1).map(({ id, name }) => ({ id, name })),
  };
}

/**
 * Deletes a user's account and everything that is only theirs:
 * organizations they own alone (all their data cascades; files are removed by the worker).
 * Their sessions, sign-in accounts, 2FA, memberships and invitations cascade from the user row.
 * Content they created in shared organizations stays with the organization (created_by is cleared).
 * Audit entries keep only the user id, which no longer resolves to a person.
 * Pass `deleteUserRow: false` when Better Auth deletes the user row itself.
 */
export async function deleteAccount(
  userId: string,
  opts: { deleteUserRow: boolean; actor: { type: "user" | "platform_admin"; id: string } },
): Promise<void> {
  const plan = await planAccountDeletion(userId);
  if (plan.blockingOrganizations.length) {
    throw new APIError("BAD_REQUEST", {
      message: `Make someone else an owner of ${plan.blockingOrganizations.map((o) => o.name).join(", ")} first, or delete it.`,
      code: "owner_of_shared_organization",
    });
  }
  const db = adminDb();
  if (plan.soloOrganizations.length) {
    const ids = plan.soloOrganizations.map((o) => o.id);
    await db.delete(organization).where(inArray(organization.id, ids));
    for (const id of ids) await enqueueOrgCleanup(id);
  }
  // Pending invitations sent to this email address would otherwise keep it.
  const [u] = await db.select({ email: user.email }).from(user).where(eq(user.id, userId));
  if (u) await db.delete(invitation).where(eq(invitation.email, u.email));
  if (opts.deleteUserRow) await db.delete(user).where(eq(user.id, userId));
  await db.insert(auditLogs).values({
    orgId: null,
    actorType: opts.actor.type,
    actorId: opts.actor.id,
    action: "user.deleted",
    targetType: "user",
    targetId: userId,
    diff: { organizationsDeleted: plan.soloOrganizations.length },
  });
}

/** Organization creation limits: one free-plan organization per user, 10 owned in total, 3 new per day. */
const MAX_OWNED_ORGS = 10;
const MAX_ORGS_PER_DAY = 3;

/**
 * Better Auth `organizationLimit`: true blocks the creation. Every organization comes with free
 * platform AI credit, so unlimited creation would let one account farm credit paid for by us.
 * The daily counter is an atomic Redis INCR, so parallel requests can't all pass the database count.
 */
export async function organizationLimitReached(userId: string): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const key = `org-create:${userId}:${day}`;
  try {
    const n = await redis().incr(key);
    if (n === 1) await redis().expire(key, 86_400);
    if (n > MAX_ORGS_PER_DAY) return true;
  } catch {
    // Redis down: fall back to the database checks below.
  }
  const [row] = await adminDb()
    .select({
      owned: sql<number>`count(*)::int`,
      free: sql<number>`count(*) filter (where ${organization.planKey} = 'free')::int`,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(and(eq(member.userId, userId), eq(member.role, "owner")));
  return (row?.free ?? 0) >= 1 || (row?.owned ?? 0) >= MAX_OWNED_ORGS;
}

/**
 * Failed password sign-ins per account (email), across all IPs. After 10 in 15 minutes the account's
 * sign-in pauses; a successful sign-in or the window expiring resets it. Emails are stored hashed.
 */
export const signInFailures = {
  limit: Number(process.env.SIGNIN_FAILURE_LIMIT ?? 10),
  windowSec: 15 * 60,
  key: (email: string) => `signin-fail:${createHash("sha256").update(email.trim().toLowerCase()).digest("hex")}`,
  async isLocked(email: string): Promise<boolean> {
    try {
      return Number(await redis().get(this.key(email))) >= this.limit;
    } catch {
      return false;
    }
  },
  async record(email: string): Promise<void> {
    try {
      const n = await redis().incr(this.key(email));
      if (n === 1) await redis().expire(this.key(email), this.windowSec);
    } catch {
      /* fail open: per-IP limits still apply */
    }
  },
  async clear(email: string): Promise<void> {
    await redis().del(this.key(email)).catch(() => undefined);
  },
};

