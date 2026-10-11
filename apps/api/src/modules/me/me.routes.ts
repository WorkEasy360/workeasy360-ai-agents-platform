import { Router } from "express";
import { eq } from "drizzle-orm";
import { appDb } from "@we360/db";
import { member, organization } from "@we360/db/schema";
import { planAccountDeletion } from "../../auth/hooks";
import { requireSession } from "../../middleware/auth";

export const meRouter = Router();

/** The signed-in user, their organizations and roles. Used by the web app on load. */
meRouter.get("/", requireSession, async (req, res) => {
  const { user, session } = req.auth!;
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
    .where(eq(member.userId, user.id))
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
    activeOrganizationId: session.activeOrganizationId ?? null,
    organizations: orgs,
  });
});

/** What "Delete my account" would do: organizations deleted with it, or ones blocking it. */
meRouter.get("/account-deletion", requireSession, async (req, res) => {
  res.json(await planAccountDeletion(req.auth!.user.id));
});
