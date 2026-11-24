import { and, eq, isNotNull, lte, sql } from "drizzle-orm";
import { APIError } from "better-auth/api";
import { appDb, type Database } from "@we360/db";
import { session as sessionTable, twoFactor } from "@we360/db/schema";
import { AppError } from "../lib/errors";
import { workeasy360Of } from "./access";

/**
 * The admin step-up of a WorkEasy360 session (docs/workeasy360-sso.md, "Admin dashboard: Agents' own second factor").
 *
 * A password sign-in of a user with two-factor authentication only gets a session after Agents' own TOTP or
 * backup code (Better Auth's two-factor challenge). A WorkEasy360 sign-in opens its session directly, and
 * WorkEasy360 says nothing about a second factor: it has no MFA, and its ID token carries no `amr`. Agents never
 * reads an `amr`, missing or present, as proof of one. So a WorkEasy360 session starts without Agents' second
 * factor, and the admin area refuses it (403 `two_factor_step_up_required`) until that session presents one.
 *
 * The step-up is Better Auth's own verification, called with the WorkEasy360 session:
 * `POST /api/auth/two-factor/verify-totp` or `/two-factor/verify-backup-code` (`{ code }`). With a session, Better
 * Auth only checks the code (a backup code is used up) and opens no session. This module then marks that one
 * session (`session.two_factor_verified_at`); another session, even of the same person, must step up itself.
 *
 * Better Auth's sign-in challenge counts wrong codes per account; its session mode does not. A WorkEasy360
 * step-up spends the same per-account budget, with the same defaults: 10 wrong codes in a row lock the factor
 * for 15 minutes (on top of the 5 requests a minute per IP in app.ts).
 */

export { STEP_UP_PATHS } from "./access";

/** Better Auth's own defaults (two-factor `accountLockout`): 10 wrong codes in a row, then 15 minutes (below). */
const MAX_FAILED_CODES = 10;

type SessionLike = Record<string, unknown> | null | undefined;
type UserLike = { twoFactorEnabled?: boolean | null } | null | undefined;

/** Whether this session of a user with two-factor authentication still has to present it (WorkEasy360 sessions only). */
export function needsStepUp(session: SessionLike, user: UserLike): boolean {
  if (!workeasy360Of(session) || !user?.twoFactorEnabled) return false;
  return !session?.twoFactorVerifiedAt;
}

/** The admin area's refusal for a WorkEasy360 session that has not presented Agents' second factor. */
export function adminStepUpRefusal(session: SessionLike, user: UserLike): AppError | undefined {
  if (!needsStepUp(session, user)) return undefined;
  return new AppError(
    403,
    "two_factor_step_up_required",
    "Enter a code from your authenticator app, or a backup code, to use the admin dashboard with your WorkEasy360 sign-in.",
  );
}

/** Before Better Auth checks a step-up code: refused while the account's factor is locked; an expired lock is cleared. */
export async function assertStepUpNotLocked(userId: string, db: Database = appDb()): Promise<void> {
  const [row] = await db.select({ lockedUntil: twoFactor.lockedUntil }).from(twoFactor).where(eq(twoFactor.userId, userId)).limit(1);
  if (!row?.lockedUntil) return;
  if (row.lockedUntil.getTime() > Date.now()) {
    throw new APIError("TOO_MANY_REQUESTS", {
      code: "ACCOUNT_TEMPORARILY_LOCKED",
      message: "Too many wrong codes. Try again in 15 minutes.",
    });
  }
  await db
    .update(twoFactor)
    .set({ failedVerificationCount: 0, lockedUntil: null })
    .where(and(eq(twoFactor.userId, userId), isNotNull(twoFactor.lockedUntil), lte(twoFactor.lockedUntil, new Date())));
}

/** A wrong step-up code: one more toward the account's budget, and the lock once it is spent (one statement). */
export async function recordStepUpFailure(userId: string, db: Database = appDb()): Promise<void> {
  const next = sql`coalesce(${twoFactor.failedVerificationCount}, 0) + 1`;
  await db
    .update(twoFactor)
    .set({
      failedVerificationCount: next,
      lockedUntil: sql`case when ${next} >= ${MAX_FAILED_CODES} then now() + interval '15 minutes' else ${twoFactor.lockedUntil} end`,
    })
    .where(eq(twoFactor.userId, userId));
}

/** A right step-up code: this session (only this one) has presented Agents' second factor; the failure count restarts. */
export async function recordStepUp(userId: string, sessionId: string, db: Database = appDb()): Promise<void> {
  await db.update(sessionTable).set({ twoFactorVerifiedAt: new Date() }).where(and(eq(sessionTable.id, sessionId), eq(sessionTable.userId, userId)));
  await db.update(twoFactor).set({ failedVerificationCount: 0, lockedUntil: null }).where(eq(twoFactor.userId, userId));
}
