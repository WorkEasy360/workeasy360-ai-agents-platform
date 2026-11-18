import { createHash, randomUUID } from "node:crypto";
import { and, count, eq, gt, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { appDb, withTenant, type Database } from "@we360/db";
import {
  agents,
  auditLogs,
  member,
  organization,
  session,
  user,
  workeasy360Entitlements,
  workeasy360Identities,
  workeasy360LoginFlows,
  workeasy360LogoutTokens,
  workeasy360Organizations,
  workspaces,
} from "@we360/db/schema";
import type { Workeasy360JoinRole } from "./config";

/** Why a sign-in was refused after the token verified (shown as `/login?sso_error=<code>`). */
export type ProvisionRefusal =
  | "no_tenant"
  | "tenant_suspended"
  | "identity_conflict"
  | "account_exists"
  | "account_suspended";

export interface ProvisionInput {
  issuer: string;
  subject: string;
  email: string;
  name: string;
  organizationId: string;
  organizationName?: string | undefined;
  defaultRole: Workeasy360JoinRole;
  provisionTenants: boolean;
  tenantPlan: string;
}

export type ProvisionOutcome =
  | { kind: "ok"; userId: string; tenantId: string; tenantCreated: boolean; membershipCreated: boolean; role: string }
  | { kind: "refused"; code: ProvisionRefusal; detail: string };

export interface LoginFlow {
  state: string;
  nonce: string;
  codeVerifier: string;
  organizationId: string | null;
  returnTo: string | null;
}

const hashId = (id: string) => createHash("sha256").update(id, "utf8").digest("hex");

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } } | undefined;
  return e?.code === "23505" || e?.cause?.code === "23505";
}

// --- login flows ---------------------------------------------------------------------

export async function saveLoginFlow(flowId: string, flow: LoginFlow, ttlSeconds: number, db: Database = appDb()): Promise<void> {
  await db.delete(workeasy360LoginFlows).where(lt(workeasy360LoginFlows.expiresAt, new Date()));
  await db.insert(workeasy360LoginFlows).values({
    idHash: hashId(flowId),
    state: flow.state,
    nonce: flow.nonce,
    codeVerifier: flow.codeVerifier,
    organizationId: flow.organizationId,
    returnTo: flow.returnTo,
    expiresAt: new Date(Date.now() + ttlSeconds * 1000),
  });
}

/** Removes the flow and returns it if it had not expired: whatever happens next, it cannot be used twice. */
export async function takeLoginFlow(flowId: string, db: Database = appDb()): Promise<LoginFlow | undefined> {
  const [row] = await db.delete(workeasy360LoginFlows).where(eq(workeasy360LoginFlows.idHash, hashId(flowId))).returning();
  if (!row || row.expiresAt.getTime() <= Date.now()) return undefined;
  return { state: row.state, nonce: row.nonce, codeVerifier: row.codeVerifier, organizationId: row.organizationId, returnTo: row.returnTo };
}

// --- sign-in --------------------------------------------------------------------------

function slugFor(organizationId: string): string {
  return `w360-${organizationId.replace(/-/g, "").slice(0, 12)}-${randomUUID().slice(0, 6)}`;
}

/**
 * The person, their Agents organization and their membership, after the ID token verified:
 *
 * - the person is the user linked to (issuer, sub); a first sign-in creates one. An Agents account with
 *   the same email address is never taken over: the sign-in is refused (`account_exists`) until an operator
 *   links the two (`link-user`). A subject already linked under another issuer name is refused
 *   (`identity_conflict`) until the issuer move runs;
 * - the organization is the tenant linked to `organization_id`; the organization's first sign-in creates it
 *   (with its default workspace) unless WORKEASY360_PROVISION_TENANTS=false (`no_tenant`);
 * - an existing membership keeps its role; a new one gets `owner` in an organization with no members yet,
 *   WORKEASY360_DEFAULT_ROLE otherwise. Who belongs to the organization is WorkEasy360's to decide.
 */
export async function provisionSignIn(input: ProvisionInput, db: Database = appDb()): Promise<ProvisionOutcome> {
  if (!input.provisionTenants) {
    // Refused before anything is created for the person.
    const [link] = await db.select({ tenantId: workeasy360Organizations.tenantId }).from(workeasy360Organizations).where(eq(workeasy360Organizations.organizationId, input.organizationId)).limit(1);
    if (!link) return { kind: "refused", code: "no_tenant", detail: "no Agents organization is linked to this WorkEasy360 organization" };
  }
  const person = await resolvePerson(input, db);
  if (person.kind === "refused") return person;
  const tenant = await resolveTenant(input, person.userId, db);
  if (tenant.kind === "refused") return tenant;

  // Serialized per organization (the member table has no unique key): two sign-ins at once add one membership,
  // and only the first person of an empty organization becomes its owner.
  const joined = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`w360-member:${tenant.tenantId}`}, 0))`);
    const [existing] = await tx
      .select({ role: member.role })
      .from(member)
      .where(and(eq(member.organizationId, tenant.tenantId), eq(member.userId, person.userId)))
      .limit(1);
    if (existing) return { created: false, role: existing.role };
    const [members] = await tx.select({ n: count() }).from(member).where(eq(member.organizationId, tenant.tenantId));
    const role = (members?.n ?? 0) === 0 ? "owner" : input.defaultRole;
    await tx.insert(member).values({ organizationId: tenant.tenantId, userId: person.userId, role, createdAt: new Date() });
    return { created: true, role };
  });
  if (!joined.created) return { kind: "ok", userId: person.userId, tenantId: tenant.tenantId, tenantCreated: tenant.created, membershipCreated: false, role: joined.role };
  const role = joined.role;
  await withTenant(tenant.tenantId, (tx) =>
    tx.insert(auditLogs).values({
      orgId: tenant.tenantId,
      actorType: "user",
      actorId: person.userId,
      action: "member.joined_with_workeasy360",
      targetType: "user",
      targetId: person.userId,
      diff: { role },
    }),
  );
  return { kind: "ok", userId: person.userId, tenantId: tenant.tenantId, tenantCreated: tenant.created, membershipCreated: true, role };
}

async function resolvePerson(input: ProvisionInput, db: Database, attempt = 0): Promise<{ kind: "ok"; userId: string } | Extract<ProvisionOutcome, { kind: "refused" }>> {
  const [linked] = await db
    .select({ userId: workeasy360Identities.userId, bannedAt: user.bannedAt, name: user.name })
    .from(workeasy360Identities)
    .innerJoin(user, eq(user.id, workeasy360Identities.userId))
    .where(and(eq(workeasy360Identities.issuer, input.issuer), eq(workeasy360Identities.subject, input.subject)))
    .limit(1);
  if (linked) {
    if (linked.bannedAt) return { kind: "refused", code: "account_suspended", detail: "the linked user is banned" };
    await db
      .update(workeasy360Identities)
      .set({ lastSignInAt: new Date() })
      .where(and(eq(workeasy360Identities.issuer, input.issuer), eq(workeasy360Identities.subject, input.subject)));
    if (input.name && input.name !== linked.name) await db.update(user).set({ name: input.name }).where(eq(user.id, linked.userId));
    return { kind: "ok", userId: linked.userId };
  }

  const [elsewhere] = await db
    .select({ issuer: workeasy360Identities.issuer })
    .from(workeasy360Identities)
    .where(and(eq(workeasy360Identities.subject, input.subject), ne(workeasy360Identities.issuer, input.issuer)))
    .limit(1);
  if (elsewhere) return { kind: "refused", code: "identity_conflict", detail: "this subject is linked under another issuer name: run move-issuer" };

  const [sameEmail] = await db.select({ id: user.id }).from(user).where(sql`lower(${user.email}) = ${input.email.toLowerCase()}`).limit(1);
  if (sameEmail) return { kind: "refused", code: "account_exists", detail: "an Agents account has this email address and is not linked to this WorkEasy360 identity" };

  try {
    const userId = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(user)
        .values({ name: input.name || input.email, email: input.email.toLowerCase(), emailVerified: true })
        .returning({ id: user.id });
      await tx.insert(workeasy360Identities).values({ issuer: input.issuer, subject: input.subject, userId: created!.id, linkedBy: "sign_in", lastSignInAt: new Date() });
      return created!.id;
    });
    return { kind: "ok", userId };
  } catch (err) {
    // Two first sign-ins of the same person at once: the other one created the user.
    if (isUniqueViolation(err) && attempt === 0) return resolvePerson(input, db, 1);
    throw err;
  }
}

async function resolveTenant(
  input: ProvisionInput,
  userId: string,
  db: Database,
  attempt = 0,
): Promise<{ kind: "ok"; tenantId: string; created: boolean } | Extract<ProvisionOutcome, { kind: "refused" }>> {
  const [link] = await db
    .select({ tenantId: workeasy360Organizations.tenantId, status: organization.status })
    .from(workeasy360Organizations)
    .innerJoin(organization, eq(organization.id, workeasy360Organizations.tenantId))
    .where(eq(workeasy360Organizations.organizationId, input.organizationId))
    .limit(1);
  if (link) {
    if (link.status !== "active") return { kind: "refused", code: "tenant_suspended", detail: "the linked Agents organization is not active" };
    return { kind: "ok", tenantId: link.tenantId, created: false };
  }
  if (!input.provisionTenants) return { kind: "refused", code: "no_tenant", detail: "no Agents organization is linked to this WorkEasy360 organization" };

  const tenantId = randomUUID();
  try {
    // One transaction: the organization, its link and its default workspace exist together or not at all.
    await withTenant(tenantId, async (tx) => {
      await tx.insert(organization).values({
        id: tenantId,
        name: (input.organizationName ?? "").trim().slice(0, 100) || "WorkEasy360 organization",
        slug: slugFor(input.organizationId),
        createdAt: new Date(),
        planKey: input.tenantPlan,
        status: "active",
      });
      await tx.insert(workeasy360Organizations).values({ organizationId: input.organizationId, tenantId, linkedBy: "sign_in" });
      const [ws] = await tx.insert(workspaces).values({ orgId: tenantId, name: "Default", slug: "default", createdBy: userId }).returning({ id: workspaces.id });
      await tx.insert(auditLogs).values({
        orgId: tenantId,
        actorType: "user",
        actorId: userId,
        action: "organization.created",
        targetType: "workspace",
        targetId: ws!.id,
        diff: { source: "workeasy360", workeasy360OrganizationId: input.organizationId },
      });
    });
    return { kind: "ok", tenantId, created: true };
  } catch (err) {
    // The organization's first two sign-ins raced: use the tenant the other one created.
    if (isUniqueViolation(err) && attempt === 0) return resolveTenant(input, userId, db, 1);
    throw err;
  }
}

// --- back-channel logout --------------------------------------------------------------

/**
 * In one transaction: records the logout token's `jti` (once per issuer) and deletes the sessions it
 * names - by `sid` (narrowed to `sub` when both are present), or every session of `sub`. A deleted
 * session is refused by every API instance on its next request (requireSession reads the database).
 * A replayed `jti` changes nothing.
 */
export async function endSessions(
  input: { issuer: string; jti: string; subject?: string | undefined; sid?: string | undefined; acceptableUntil: Date },
  db: Database = appDb(),
): Promise<{ replayed: boolean; sessionsEnded: number }> {
  return db.transaction(async (tx) => {
    await tx.delete(workeasy360LogoutTokens).where(lt(workeasy360LogoutTokens.expiresAt, new Date()));
    const recorded = await tx
      .insert(workeasy360LogoutTokens)
      .values({ issuer: input.issuer, jti: input.jti, expiresAt: input.acceptableUntil })
      .onConflictDoNothing()
      .returning({ jti: workeasy360LogoutTokens.jti });
    if (recorded.length === 0) return { replayed: true, sessionsEnded: 0 };
    const conditions = [eq(session.workeasy360Issuer, input.issuer)];
    if (input.sid) conditions.push(eq(session.workeasy360Sid, input.sid));
    if (input.subject) conditions.push(eq(session.workeasy360Subject, input.subject));
    const ended = await tx.delete(session).where(and(...conditions)).returning({ id: session.id });
    return { replayed: false, sessionsEnded: ended.length };
  });
}

/** The ID token a WorkEasy360 session was opened with (id_token_hint), read from the database only. */
export async function idTokenOfSession(sessionId: string, db: Database = appDb()): Promise<string | undefined> {
  const [row] = await db.select({ idToken: session.workeasy360IdToken }).from(session).where(eq(session.id, sessionId)).limit(1);
  return row?.idToken ?? undefined;
}

/** The WorkEasy360 organization an Agents organization is linked to, if any. */
export async function linkedOrganizationOf(tenantId: string, db: Database = appDb()): Promise<string | undefined> {
  const [row] = await db
    .select({ organizationId: workeasy360Organizations.organizationId })
    .from(workeasy360Organizations)
    .where(eq(workeasy360Organizations.tenantId, tenantId))
    .limit(1);
  return row?.organizationId;
}

// --- shared entitlement answers ---------------------------------------------------------

export async function getEntitlementAnswer(key: string, db: Database = appDb()): Promise<string | null> {
  const [row] = await db
    .select({ value: workeasy360Entitlements.value })
    .from(workeasy360Entitlements)
    .where(and(eq(workeasy360Entitlements.key, key), or(isNull(workeasy360Entitlements.expiresAt), gt(workeasy360Entitlements.expiresAt, new Date()))))
    .limit(1);
  return row?.value ?? null;
}

export async function putEntitlementAnswer(key: string, value: string, ttlSeconds: number | null, db: Database = appDb()): Promise<void> {
  const expiresAt = ttlSeconds === null ? null : new Date(Date.now() + ttlSeconds * 1000);
  await db
    .insert(workeasy360Entitlements)
    .values({ key, value, expiresAt, updatedAt: new Date() })
    .onConflictDoUpdate({ target: workeasy360Entitlements.key, set: { value, expiresAt, updatedAt: new Date() } });
}

// --- operator commands (src/scripts/workeasy360.ts), run as the schema owner ---------------------

export type OperatorResult = { ok: true; message: string } | { ok: false; message: string };

/**
 * Sign-ins from `organizationId` land in the existing Agents organization `tenantId`. A tenant linked to
 * another WorkEasy360 organization is never re-pointed. If a first sign-in already created a tenant for
 * the organization, this refuses - unless `replaceEmpty` and that tenant has no agents: it is then
 * unlinked and suspended, and its WorkEasy360 sessions end.
 */
export async function linkOrganization(db: Database, tenantId: string, organizationId: string, options: { replaceEmpty: boolean }): Promise<OperatorResult> {
  const [tenant] = await db.select({ id: organization.id, status: organization.status }).from(organization).where(eq(organization.id, tenantId)).limit(1);
  if (!tenant) return { ok: false, message: `No Agents organization ${tenantId}.` };
  const [current] = await db.select().from(workeasy360Organizations).where(eq(workeasy360Organizations.tenantId, tenantId)).limit(1);
  if (current) {
    if (current.organizationId === organizationId) return { ok: true, message: "Already linked; nothing changed." };
    return { ok: false, message: `Organization ${tenantId} is linked to WorkEasy360 organization ${current.organizationId}; it is never re-pointed.` };
  }
  const [other] = await db.select().from(workeasy360Organizations).where(eq(workeasy360Organizations.organizationId, organizationId)).limit(1);
  return db.transaction(async (tx) => {
    if (other) {
      if (!options.replaceEmpty) {
        return { ok: false, message: `WorkEasy360 organization ${organizationId} already signs in to ${other.tenantId}. Add --replace-empty to unlink and suspend that organization if it has no agents.` };
      }
      const [agentCount] = await tx.select({ n: count() }).from(agents).where(eq(agents.orgId, other.tenantId));
      if ((agentCount?.n ?? 0) > 0) return { ok: false, message: `${other.tenantId} has agents; it is not replaced.` };
      await tx.delete(workeasy360Organizations).where(eq(workeasy360Organizations.organizationId, organizationId));
      await tx.update(organization).set({ status: "suspended" }).where(eq(organization.id, other.tenantId));
      await tx.delete(session).where(eq(session.workeasy360TenantId, other.tenantId));
    }
    await tx.insert(workeasy360Organizations).values({ organizationId, tenantId, linkedBy: "operator" });
    await tx.insert(auditLogs).values({
      orgId: tenantId,
      actorType: "system",
      actorId: null,
      action: "organization.linked_to_workeasy360",
      targetType: "organization",
      targetId: tenantId,
      diff: { workeasy360OrganizationId: organizationId, replaced: other?.tenantId ?? null },
    });
    return { ok: true, message: `Sign-ins from WorkEasy360 organization ${organizationId} now land in ${tenantId}.${other ? ` ${other.tenantId} was unlinked and suspended.` : ""}` };
  });
}

/**
 * The operator vouches that the Agents user `userId` (a password or Google account) is the WorkEasy360
 * person `subject`: that user then signs in with WorkEasy360 and keeps its memberships and roles.
 * Refused when the identity is already linked, or the user already has an identity under this issuer.
 */
export async function linkUser(db: Database, userId: string, subject: string, issuer: string): Promise<OperatorResult> {
  const [u] = await db.select({ id: user.id }).from(user).where(eq(user.id, userId)).limit(1);
  if (!u) return { ok: false, message: `No user ${userId}.` };
  const [taken] = await db
    .select({ userId: workeasy360Identities.userId })
    .from(workeasy360Identities)
    .where(and(eq(workeasy360Identities.issuer, issuer), eq(workeasy360Identities.subject, subject)))
    .limit(1);
  if (taken) return taken.userId === userId ? { ok: true, message: "Already linked; nothing changed." } : { ok: false, message: `That WorkEasy360 identity is already linked to user ${taken.userId}; two accounts are never merged.` };
  const [own] = await db
    .select({ subject: workeasy360Identities.subject })
    .from(workeasy360Identities)
    .where(and(eq(workeasy360Identities.issuer, issuer), eq(workeasy360Identities.userId, userId)))
    .limit(1);
  if (own) return { ok: false, message: `User ${userId} is already linked to WorkEasy360 subject ${own.subject} under this issuer.` };
  await db.insert(workeasy360Identities).values({ issuer, subject, userId, linkedBy: "operator" });
  await db.insert(auditLogs).values({ orgId: null, actorType: "system", actorId: null, action: "user.linked_to_workeasy360", targetType: "user", targetId: userId, diff: { issuer } });
  return { ok: true, message: `User ${userId} now signs in as WorkEasy360 subject ${subject} (${issuer}).` };
}

/**
 * The identity move of an issuer change (ADR-067): every (from, sub) becomes (to, sub), and so do live
 * WorkEasy360 sessions. Without `apply` it only reports. Refused, listing them, when a subject already
 * has a user under the new issuer name: two accounts are never merged.
 */
export async function moveIssuer(db: Database, from: string, to: string, apply: boolean): Promise<OperatorResult> {
  if (from === to) return { ok: false, message: "--from and --to are the same." };
  const moving = await db.select({ subject: workeasy360Identities.subject, userId: workeasy360Identities.userId }).from(workeasy360Identities).where(eq(workeasy360Identities.issuer, from));
  const subjects = moving.map((m) => m.subject);
  const clashes = subjects.length
    ? await db
        .select({ subject: workeasy360Identities.subject, userId: workeasy360Identities.userId })
        .from(workeasy360Identities)
        .where(and(eq(workeasy360Identities.issuer, to), inArray(workeasy360Identities.subject, subjects)))
    : [];
  if (clashes.length) {
    return { ok: false, message: `Refused: ${clashes.length} subject(s) already have a user under ${to}:\n${clashes.map((c) => `  ${c.subject} -> ${c.userId}`).join("\n")}` };
  }
  const [live] = await db.select({ n: count() }).from(session).where(eq(session.workeasy360Issuer, from));
  if (!apply) return { ok: true, message: `Would move ${moving.length} identity link(s) and ${live?.n ?? 0} live session(s) from ${from} to ${to}. Add --apply.` };
  await db.transaction(async (tx) => {
    await tx.update(workeasy360Identities).set({ issuer: to }).where(eq(workeasy360Identities.issuer, from));
    await tx.update(session).set({ workeasy360Issuer: to }).where(eq(session.workeasy360Issuer, from));
    await tx.insert(auditLogs).values({ orgId: null, actorType: "system", actorId: null, action: "workeasy360.issuer_moved", targetType: "issuer", targetId: null, diff: { from, to, identities: moving.length } });
  });
  return { ok: true, message: `Moved ${moving.length} identity link(s) and ${live?.n ?? 0} live session(s) from ${from} to ${to}.` };
}

/** Linked users and live WorkEasy360 sessions per issuer, so an operator can see whether a move is needed. */
export async function identitiesReport(db: Database): Promise<Array<{ issuer: string; users: number; liveSessions: number }>> {
  const users = await db.select({ issuer: workeasy360Identities.issuer, n: count() }).from(workeasy360Identities).groupBy(workeasy360Identities.issuer);
  const sessions = await db
    .select({ issuer: session.workeasy360Issuer, n: count() })
    .from(session)
    .where(and(sql`${session.workeasy360Issuer} is not null`, gt(session.expiresAt, new Date())))
    .groupBy(session.workeasy360Issuer);
  const issuers = new Set([...users.map((u) => u.issuer), ...sessions.map((s) => s.issuer!)]);
  return [...issuers].sort().map((issuer) => ({
    issuer,
    users: users.find((u) => u.issuer === issuer)?.n ?? 0,
    liveSessions: sessions.find((s) => s.issuer === issuer)?.n ?? 0,
  }));
}
