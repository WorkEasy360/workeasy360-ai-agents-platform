import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { appDb } from "@we360/db";
import { member, organization } from "@we360/db/schema";
import { planAccountDeletion } from "../../auth/hooks";
import { requireSession } from "../../middleware/auth";
import { workeasy360Of } from "../../workeasy360/access";

export const meRouter = Router();

/** The signed-in user, their organizations and roles. Used by the web app on load. */
meRouter.get("/", requireSession, async (req, res) => {
  const { user, session } = req.auth!;
  // A WorkEasy360 session lists only the organization it was opened for.
  const w360 = workeasy360Of(session as unknown as Record<string, unknown>);
  const orgs = await appDb()
    .select({
      id: organization.id,
      name: organization.name,
      slug: organization.slug,
      logo: organization.logo,
      planKey: organization.planKey,
      status: organization.status,
      role: member.role,
    })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(w360 ? and(eq(member.userId, user.id), eq(member.organizationId, w360.tenantId)) : eq(member.userId, user.id))
    .orderBy(organization.name);

  const u = user as typeof user & { platformRole?: string | null; twoFactorEnabled?: boolean | null };
  res.json({
    user: {
      id: u.id,
      name: u.name,
      email: u.email,
      image: u.image,
      emailVerified: u.emailVerified,
      twoFactorEnabled: Boolean(u.twoFactorEnabled),
      platformRole: u.platformRole ?? null,
    },
    activeOrganizationId: w360 ? w360.tenantId : (session.activeOrganizationId ?? null),
    organizations: orgs,
    // How this session signed in: the web app offers "Sign out of WorkEasy360 too" for "workeasy360".
    signedInWith: w360 ? "workeasy360" : "local",
  });
});

/** What "Delete my account" would do: organizations deleted with it, or ones blocking it. */
meRouter.get("/account-deletion", requireSession, async (req, res) => {
  res.json(await planAccountDeletion(req.auth!.user.id));
});
