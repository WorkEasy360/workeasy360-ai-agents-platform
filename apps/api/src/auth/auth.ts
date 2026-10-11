import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization, twoFactor } from "better-auth/plugins";
import { appDb } from "@we360/db";
import * as schema from "@we360/db/schema";
import { env } from "../config/env";
import { notify } from "../modules/notifications/notify";
import { getOrgLimits, limitOrInfinity } from "../modules/plans/plan-limits";
import { enqueueOrgCleanup } from "../lib/queue";
import { assertSeatAvailable, assertSignupAllowed, deleteAccount, onOrganizationCreated, organizationLimitReached, signInFailures } from "./hooks";
import { hashPassword, needsRehash, verifyPassword } from "./password";

const google =
  env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
    ? { google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } }
    : undefined;

export const auth = betterAuth({
  appName: "WorkEasy360 Agents",
  // The browser only ever sees APP_URL; Next.js proxies /api/* to this service.
  baseURL: env.APP_URL,
  basePath: "/api/auth",
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: [env.APP_URL],
  database: drizzleAdapter(appDb(), { provider: "pg", schema }),
  advanced: {
    database: { generateId: "uuid" },
    useSecureCookies: env.isProduction,
  },
  emailAndPassword: {
    enabled: true,
    // Without email (SES_REGION unset) nobody could verify, so accounts are treated as verified instead
    // and public sign-up stays closed (see assertSignupAllowed).
    requireEmailVerification: env.isProduction && env.emailEnabled,
    minPasswordLength: 10,
    // Argon2id; older scrypt hashes still verify and are upgraded at sign-in (see hooks.after).
    password: { hash: hashPassword, verify: verifyPassword },
    // A reset link works for 1 hour, and using it signs the account out everywhere else.
    resetPasswordTokenExpiresIn: 60 * 60,
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, url }) => {
      await notify.resetPassword(user.email, url);
    },
    onPasswordReset: async ({ user }) => {
      await notify.passwordChanged(user.email);
    },
  },
  emailVerification: {
    sendOnSignUp: env.emailEnabled,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      await notify.verifyEmail(user.email, url);
    },
  },
  // Single-use tokens (password reset, email change) are stored as SHA-256 hashes, so a database
  // read doesn't reveal working links. Better Auth deletes each token when it is used.
  verification: { storeIdentifier: "hashed" },
  socialProviders: google,
  // Google sign-in tokens are stored encrypted (with BETTER_AUTH_SECRET), not in plain text.
  account: { encryptOAuthTokens: true },
  user: {
    // "Delete my account" (Settings → Security). Needs the password, or a session under a day old
    // for Google-only accounts. Organizations the user owns alone are deleted with the account.
    deleteUser: {
      enabled: true,
      beforeDelete: async (u) => {
        await deleteAccount(u.id, { deleteUserRow: false, actor: { type: "user", id: u.id } });
      },
      afterDelete: async (u) => {
        await notify.accountDeleted(u.email);
      },
    },
    additionalFields: {
      // null for customers; "super_admin" | "support" for platform staff. Set only via the admin CLI/API.
      platformRole: { type: "string", required: false, input: false },
      bannedAt: { type: "date", required: false, input: false },
      banReason: { type: "string", required: false, input: false },
    },
  },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      // Per-account brute-force protection (per-IP limits alone don't stop a distributed attack).
      if (ctx.path !== "/sign-in/email") return;
      const email = (ctx.body as { email?: unknown } | undefined)?.email;
      if (typeof email === "string" && (await signInFailures.isLocked(email))) {
        throw new APIError("TOO_MANY_REQUESTS", { message: "Too many failed sign-in attempts. Try again in 15 minutes, or reset your password." });
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      if (ctx.path === "/change-password" && !(ctx.context.returned instanceof APIError) && ctx.context.session) {
        await notify.passwordChanged(ctx.context.session.user.email);
      }
      if (ctx.path === "/sign-in/email") {
        const email = (ctx.body as { email?: unknown } | undefined)?.email;
        if (typeof email === "string") {
          if (ctx.context.newSession) await signInFailures.clear(email);
          else if (ctx.context.returned instanceof APIError && ctx.context.returned.statusCode === 401) await signInFailures.record(email);
        }
      }
      // The password was just verified, so this is the one moment an old hash can be replaced.
      if (ctx.path !== "/sign-in/email" || !ctx.context.newSession) return;
      const password = (ctx.body as { password?: unknown } | undefined)?.password;
      if (typeof password !== "string") return;
      const account = await ctx.context.internalAdapter.findCredentialAccount(ctx.context.newSession.user.id);
      if (account?.password && needsRehash(account.password)) {
        await ctx.context.internalAdapter.updateAccount(account.id, { password: await hashPassword(password) });
      }
    }),
  },
  databaseHooks: {
    user: {
      create: {
        before: async (newUser) => {
          await assertSignupAllowed(newUser.email);
          // Without email, verification links can't be delivered: treat new accounts as verified.
          if (!env.emailEnabled) return { data: { ...newUser, emailVerified: true } };
        },
      },
      update: {
        before: async (data, ctx) => {
          // Security notice when two-factor authentication is switched on or off for the signed-in user.
          const current = ctx?.context.session?.user as { email: string; twoFactorEnabled?: boolean | null } | undefined;
          const next = (data as { twoFactorEnabled?: unknown }).twoFactorEnabled;
          if (current && typeof next === "boolean" && Boolean(current.twoFactorEnabled) !== next) {
            await notify.twoFactorChanged(current.email, next);
          }
        },
      },
    },
    session: {
      create: {
        before: async (session) => {
          const user = await appDb().query.user.findFirst({
            where: (u, { eq }) => eq(u.id, session.userId),
            columns: { bannedAt: true },
          });
          if (user?.bannedAt) {
            throw new APIError("FORBIDDEN", { message: "This account has been suspended." });
          }
        },
      },
    },
  },
  plugins: [
    organization({
      creatorRole: "owner",
      // Each organization starts with free platform AI credit, so creation is capped per user (see hooks.ts).
      organizationLimit: (user) => organizationLimitReached(user.id),
      // Enforced by Better Auth when members join, so invitations can't bypass plan limits.
      membershipLimit: async (_user, org) => limitOrInfinity((await getOrgLimits(org.id)).members),
      // Without email, admins copy the link from Settings → Members instead.
      sendInvitationEmail: async ({ email, organization: org, inviter, id, role, invitation }) => {
        await notify.invitation(email, { inviterName: inviter.user.name, orgName: org.name, role, invitationId: id, expiresAt: new Date(invitation.expiresAt) });
      },
      schema: {
        organization: {
          additionalFields: {
            planKey: { type: "string", required: true, defaultValue: "free", input: false },
            status: { type: "string", required: true, defaultValue: "active", input: false },
            planOverrides: { type: "json", required: false, input: false },
          },
        },
      },
      organizationHooks: {
        afterCreateOrganization: async ({ organization: org, user }) => {
          await onOrganizationCreated(org.id, user.id);
        },
        afterDeleteOrganization: async ({ organization: org }) => {
          // Rows are removed by ON DELETE CASCADE; uploaded files are removed by the worker.
          await enqueueOrgCleanup(org.id);
        },
        beforeCreateInvitation: async ({ organization: org }) => {
          await assertSeatAvailable(org.id);
        },
      },
    }),
    twoFactor({ issuer: "WorkEasy360 Agents" }),
  ],
});

export type Auth = typeof auth;
export type AuthSession = typeof auth.$Infer.Session;
