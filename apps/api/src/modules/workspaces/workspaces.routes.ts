import { Router } from "express";
import { asc, isNull } from "drizzle-orm";
import { withTenant } from "@we360/db";
import { workspaces } from "@we360/db/schema";
import { requireSession, requireTenant } from "../../middleware/auth";

export const workspacesRouter = Router();
workspacesRouter.use(requireSession, requireTenant);

// No org filter in the query: RLS limits rows to the tenant set by withTenant.
workspacesRouter.get("/", async (req, res) => {
  const rows = await withTenant(req.tenant!.orgId, (tx) =>
    tx
      .select({ id: workspaces.id, name: workspaces.name, slug: workspaces.slug, createdAt: workspaces.createdAt })
      .from(workspaces)
      .where(isNull(workspaces.deletedAt))
      .orderBy(asc(workspaces.createdAt)),
  );
  res.json({ data: rows });
});
