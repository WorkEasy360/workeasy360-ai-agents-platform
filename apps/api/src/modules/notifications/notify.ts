import { and, eq, inArray } from "drizzle-orm";
import { appDb } from "@we360/db";
import { member, organization, user } from "@we360/db/schema";
import { env } from "../../config/env";
import { redis } from "../../lib/queue";
import { formatEmailDate, queueMail } from "../../lib/mailer";

/**
 * Every email the platform sends, in one place. Each function only queues the message (see lib/mailer.ts),
 * so callers can await it without slowing the request noticeably, and it never throws.
 */

const PRODUCT = "WorkEasy360 Agents";
const signature = `\n\n— ${PRODUCT}\n${env.APP_URL}`;

export const notify = {
  verifyEmail: (to: string, url: string) =>
    queueMail("verify-email", {
      to,
      subject: "Verify your email",
      text: `Welcome to ${PRODUCT}. Confirm your email address to finish setting up your account:\n\n${url}\n\nIf you didn't sign up, ignore this email.${signature}`,
    }),

  resetPassword: (to: string, url: string) =>
    queueMail("reset-password", {
      to,
      subject: "Reset your password",
      text: `Reset your ${PRODUCT} password:\n\n${url}\n\nThis link works once and expires in 1 hour. If you didn't ask for this, ignore this email; your password won't change.${signature}`,
    }),

  invitation: (to: string, p: { inviterName: string; orgName: string; role: string; invitationId: string; expiresAt: Date }) =>
    queueMail("invitation", {
      to,
      subject: `You're invited to ${p.orgName} on ${PRODUCT}`,
      text: `${p.inviterName} invited you to join ${p.orgName} as ${p.role}.\n\nAccept the invitation:\n${invitationUrl(p.invitationId)}\n\nSign in or create an account with this email address (${to}). The invitation expires on ${formatEmailDate(p.expiresAt)}.${signature}`,
    }),

  passwordChanged: (to: string) =>
    queueMail("password-changed", {
      to,
      subject: "Your password was changed",
      text: `The password for your ${PRODUCT} account (${to}) was changed on ${formatEmailDate(new Date())}.\n\nIf this wasn't you, reset your password now at ${env.APP_URL}/forgot-password and contact your administrator.${signature}`,
    }),

  twoFactorChanged: (to: string, enabled: boolean) =>
    queueMail("two-factor-changed", {
      to,
      subject: enabled ? "Two-factor authentication turned on" : "Two-factor authentication turned off",
      text: `Two-factor authentication was turned ${enabled ? "on" : "off"} for your ${PRODUCT} account (${to}) on ${formatEmailDate(new Date())}.\n\nIf this wasn't you, reset your password now at ${env.APP_URL}/forgot-password.${signature}`,
    }),

  accountDeleted: (to: string) =>
    queueMail("account-deleted", {
      to,
      subject: "Your account was deleted",
      text: `Your ${PRODUCT} account (${to}) was deleted on ${formatEmailDate(new Date())}, together with the organizations you owned alone.\n\nIf you didn't do this, reply to your administrator immediately.${signature}`,
    }),

  /** Owners and admins of an organization, after a platform admin suspended or reactivated it. */
  async organizationStatus(orgId: string, orgName: string, status: "active" | "suspended") {
    const suspended = status === "suspended";
    for (const to of await orgAdminEmails(orgId)) {
      await queueMail("organization-status", {
        to,
        subject: suspended ? `${orgName} has been suspended` : `${orgName} is active again`,
        text: suspended
          ? `Your organization ${orgName} on ${PRODUCT} has been suspended. Its agents don't answer and its members can't make changes until it is reactivated.\n\nContact support to resolve this.${signature}`
          : `Your organization ${orgName} on ${PRODUCT} has been reactivated. Agents and settings work again.${signature}`,
      });
    }
  },

  /**
   * Owners and admins, once per month per threshold, when the organization's included AI credits reach
   * 80% or 100%. Redis SET NX makes sure concurrent runs send only one email.
   */
  async usageAlert(orgId: string, p: { usedUsd: number; limitUsd: number }) {
    const pct = p.usedUsd / p.limitUsd;
    const threshold = pct >= 1 ? 100 : pct >= 0.8 ? 80 : 0;
    if (!threshold) return;
    const month = new Date().toISOString().slice(0, 7);
    const first = await redis().set(`usage-alert:${orgId}:${month}:${threshold}`, "1", "EX", 40 * 86400, "NX");
    if (!first) return;
    const [org] = await appDb().select({ name: organization.name }).from(organization).where(eq(organization.id, orgId));
    for (const to of await orgAdminEmails(orgId)) {
      await queueMail("usage-alert", {
        to,
        subject: threshold === 100 ? `${org?.name ?? "Your organization"} has used all of this month's AI credits` : `${org?.name ?? "Your organization"} has used 80% of this month's AI credits`,
        text: `${org?.name ?? "Your organization"} has used $${p.usedUsd.toFixed(2)} of the $${p.limitUsd.toFixed(2)} in AI credits included this month.\n\n${threshold === 100 ? "Agents that use platform credits stop answering until next month." : "When credits run out, agents that use platform credits stop answering until next month."} You can upgrade your plan, or add your own model key in AI settings: ${env.APP_URL}/settings/ai${signature}`,
      });
    }
  },

  agentToolEmail: (to: string, subject: string, text: string) => queueMail("agent-tool", { to, subject, text }),
};

export function invitationUrl(invitationId: string): string {
  return `${env.APP_URL}/accept-invitation/${invitationId}`;
}

async function orgAdminEmails(orgId: string): Promise<string[]> {
  const rows = await appDb()
    .select({ email: user.email })
    .from(member)
    .innerJoin(user, eq(user.id, member.userId))
    .where(and(eq(member.organizationId, orgId), inArray(member.role, ["owner", "admin"])));
  return rows.map((r) => r.email);
}
