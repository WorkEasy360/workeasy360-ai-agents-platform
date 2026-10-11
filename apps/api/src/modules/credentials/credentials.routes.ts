import { Router } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { withTenant } from "@we360/db";
import { credentials } from "@we360/db/schema";
import { encryptSecret, last4 } from "../../lib/crypto";
import { AppError } from "../../lib/errors";
import { audit, parse, tenantOf, uuidParam } from "../../lib/http";
import { requireRole, requireSession, requireTenant } from "../../middleware/auth";

/**
 * Credentials for API tools. Secrets are write-only: the API never returns them,
 * only `last4` and metadata. Only API-tool credentials (integration "http") are managed here;
 * model provider keys live under /ai-settings and the webhook secret under /api-keys.
 */
export const credentialsRouter = Router();
credentialsRouter.use(requireSession, requireTenant);

const publicColumns = {
  id: credentials.id,
  name: credentials.name,
  authType: credentials.authType,
  last4: credentials.last4,
  metadata: credentials.metadata,
  status: credentials.status,
  createdAt: credentials.createdAt,
  updatedAt: credentials.updatedAt,
};

credentialsRouter.get("/", async (req, res) => {
  const { orgId, workspaceId } = tenantOf(req);
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select(publicColumns)
      .from(credentials)
      .where(
        and(eq(credentials.workspaceId, workspaceId), isNull(credentials.deletedAt), eq(credentials.integrationKey, "http")),
      )
      .orderBy(desc(credentials.createdAt)),
  );
  res.json({ data: rows });
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  authType: z.enum(["bearer", "api_key", "basic", "header"]),
  secret: z.string().min(1).max(4000),
  headerName: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,100}$/)
    .optional(),
});

credentialsRouter.post("/", requireRole("admin"), async (req, res) => {
  const { orgId, workspaceId } = tenantOf(req);
  const body = parse(createSchema, req.body);
  if ((body.authType === "api_key" || body.authType === "header") && !body.headerName) {
    throw AppError.badRequest("Enter the header name the API expects, e.g. X-API-Key.");
  }
  const enc = await encryptSecret(body.secret);
  const [row] = await withTenant(orgId, async (tx) => {
    const inserted = await tx
      .insert(credentials)
      .values({
        orgId,
        workspaceId,
        integrationKey: "http",
        name: body.name,
        authType: body.authType,
        ...enc,
        last4: last4(body.secret),
        metadata: body.headerName ? { headerName: body.headerName } : {},
        createdBy: req.auth!.user.id,
      })
      .returning(publicColumns);
    await audit(req, { action: "credential.created", targetType: "credential", targetId: inserted[0]!.id }, tx);
    return inserted;
  });
  res.status(201).json(row);
});

credentialsRouter.patch("/:id", requireRole("admin"), async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  const body = parse(createSchema.partial(), req.body);
  const enc = body.secret ? { ...(await encryptSecret(body.secret)), last4: last4(body.secret) } : {};
  const [row] = await withTenant(orgId, async (tx) => {
    const updated = await tx
      .update(credentials)
      .set({
        name: body.name,
        authType: body.authType,
        ...enc,
        // Bearer/basic don't use a header name; clear any left over from a previous auth type.
        ...(body.authType === "bearer" || body.authType === "basic"
          ? { metadata: {} }
          : body.headerName !== undefined
            ? { metadata: { headerName: body.headerName } }
            : {}),
      })
      .where(and(eq(credentials.id, id), isNull(credentials.deletedAt), eq(credentials.integrationKey, "http")))
      .returning(publicColumns);
    if (updated[0]) await audit(req, { action: body.secret ? "credential.rotated" : "credential.updated", targetType: "credential", targetId: id }, tx);
    return updated;
  });
  if (!row) throw AppError.notFound("Credential");
  res.json(row);
});

credentialsRouter.delete("/:id", requireRole("admin"), async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  await withTenant(orgId, async (tx) => {
    // Hard delete: the encrypted secret is not kept. Tools using it are detached (FK: on delete set null),
    // so the UI shows "no credential" instead of silently calling without auth.
    const [row] = await tx
      .delete(credentials)
      .where(and(eq(credentials.id, id), isNull(credentials.deletedAt), eq(credentials.integrationKey, "http")))
      .returning({ id: credentials.id });
    if (!row) throw AppError.notFound("Credential");
    await audit(req, { action: "credential.deleted", targetType: "credential", targetId: id }, tx);
  });
  res.status(204).end();
});
