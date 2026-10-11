import { Router } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { withTenant } from "@we360/db";
import { agentVersionTools, credentials, tools } from "@we360/db/schema";
import { decryptSecret } from "../../lib/crypto";
import { AppError } from "../../lib/errors";
import { audit, parse, tenantOf, uuidParam } from "../../lib/http";
import { perUserLimit } from "../../lib/rate-limit";
import { requireSession, requireTenant } from "../../middleware/auth";
import { buildHttpTool, httpConfigSchema, inputSchemaFromParams } from "../../runtime/tools/http-request";
import { KNOWLEDGE_TOOL_NAME } from "../../runtime/tools/knowledge-search";
import { buildEmailTool, EMAIL_INPUT_SCHEMA, emailConfigSchema } from "../../runtime/tools/send-email";
import { toolCatalog } from "../../runtime/tools/registry";

export const toolsRouter = Router();
toolsRouter.use(requireSession, requireTenant);

toolsRouter.get("/catalog", (_req, res) => {
  res.json({ data: toolCatalog });
});

toolsRouter.get("/", async (req, res) => {
  const { orgId, workspaceId } = tenantOf(req);
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select({
        id: tools.id,
        providerKey: tools.providerKey,
        name: tools.name,
        description: tools.description,
        config: tools.config,
        credentialId: tools.credentialId,
        credentialName: credentials.name,
        updatedAt: tools.updatedAt,
      })
      .from(tools)
      .leftJoin(credentials, eq(credentials.id, tools.credentialId))
      .where(and(eq(tools.workspaceId, workspaceId), isNull(tools.deletedAt)))
      .orderBy(desc(tools.updatedAt)),
  );
  res.json({ data: rows });
});

const PROVIDERS = ["http_request", "send_email"] as const;

const toolSchema = z.object({
  providerKey: z.enum(PROVIDERS).default("http_request"),
  name: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,63}$/, "Use lowercase letters, numbers and underscores (e.g. lookup_order)")
    .refine((n) => n !== KNOWLEDGE_TOOL_NAME, "That name is reserved"),
  description: z.string().trim().min(10, "Describe when the agent should use this tool").max(1000),
  config: z.record(z.string(), z.unknown()),
  credentialId: z.uuid().nullable().optional(),
});

/** Validates provider-specific config and derives the model-facing input schema. */
function providerConfig(providerKey: (typeof PROVIDERS)[number], config: unknown) {
  if (providerKey === "send_email") {
    return { config: parse(emailConfigSchema, config), inputSchema: EMAIL_INPUT_SCHEMA, operationKey: "send" };
  }
  const http = parse(httpConfigSchema, config);
  return { config: http, inputSchema: inputSchemaFromParams(http.params), operationKey: "request" };
}

async function assertCredential(orgId: string, credentialId: string | null | undefined) {
  if (!credentialId) return;
  const [c] = await withTenant(orgId, (tx) =>
    tx.select({ id: credentials.id }).from(credentials).where(and(eq(credentials.id, credentialId), isNull(credentials.deletedAt))),
  );
  if (!c) throw AppError.badRequest("Selected credential doesn't exist.");
}

toolsRouter.post("/", async (req, res) => {
  const { orgId, workspaceId } = tenantOf(req);
  const body = parse(toolSchema, req.body);
  await assertCredential(orgId, body.credentialId);
  const derived = providerConfig(body.providerKey, body.config);
  const [row] = await withTenant(orgId, async (tx) => {
    const inserted = await tx
      .insert(tools)
      .values({
        orgId,
        workspaceId,
        providerKey: body.providerKey,
        operationKey: derived.operationKey,
        name: body.name,
        description: body.description,
        inputSchema: derived.inputSchema,
        config: derived.config,
        credentialId: body.providerKey === "send_email" ? null : (body.credentialId ?? null),
        createdBy: req.auth!.user.id,
      })
      .returning();
    await audit(req, { action: "tool.created", targetType: "tool", targetId: inserted[0]!.id }, tx);
    return inserted;
  });
  res.status(201).json(row);
});

toolsRouter.patch("/:id", async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  const body = parse(toolSchema.omit({ providerKey: true }).partial(), req.body);
  await assertCredential(orgId, body.credentialId);
  const [row] = await withTenant(orgId, async (tx) => {
    const [current] = await tx.select({ providerKey: tools.providerKey }).from(tools).where(and(eq(tools.id, id), isNull(tools.deletedAt)));
    if (!current) throw AppError.notFound("Tool");
    const derived = body.config ? providerConfig(current.providerKey as (typeof PROVIDERS)[number], body.config) : undefined;
    const updated = await tx
      .update(tools)
      .set({
        name: body.name,
        description: body.description,
        config: derived?.config,
        inputSchema: derived?.inputSchema,
        credentialId: current.providerKey === "send_email" ? null : body.credentialId,
      })
      .where(and(eq(tools.id, id), isNull(tools.deletedAt)))
      .returning();
    if (updated[0]) await audit(req, { action: "tool.updated", targetType: "tool", targetId: id }, tx);
    return updated;
  });
  if (!row) throw AppError.notFound("Tool");
  res.json(row);
});

toolsRouter.delete("/:id", async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  await withTenant(orgId, async (tx) => {
    const [row] = await tx.update(tools).set({ deletedAt: new Date() }).where(and(eq(tools.id, id), isNull(tools.deletedAt))).returning({ id: tools.id });
    if (!row) throw AppError.notFound("Tool");
    await audit(req, { action: "tool.deleted", targetType: "tool", targetId: id }, tx);
  });
  res.status(204).end();
});

/** Runs the tool once with sample input, so users can check URL/auth before an agent uses it. */
toolsRouter.post("/:id/test", perUserLimit("tool-test", 20), async (req, res) => {
  const { orgId, workspaceId } = tenantOf(req);
  const id = uuidParam(req, "id");
  const { input } = parse(z.object({ input: z.record(z.string(), z.unknown()).default({}) }), req.body ?? {});
  const { row, cred } = await withTenant(orgId, async (tx) => {
    const [row] = await tx.select().from(tools).where(and(eq(tools.id, id), isNull(tools.deletedAt)));
    if (!row) throw AppError.notFound("Tool");
    const [cred] = row.credentialId ? await tx.select().from(credentials).where(eq(credentials.id, row.credentialId)) : [];
    return { row, cred };
  });
  if (row.providerKey === "send_email") {
    const rt = buildEmailTool({ name: row.name, description: row.description, config: emailConfigSchema.parse(row.config), requiresApproval: false });
    const out = await rt.execute(
      { subject: String(input.subject ?? "Test email"), body: String(input.body ?? "This is a test from your WorkEasy360 agent tool.") },
      { orgId, workspaceId, agentId: "", executionId: "test", signal: AbortSignal.timeout(20_000) },
    );
    return res.json({ output: out.forModel, trace: out.forTrace });
  }
  const cfg = httpConfigSchema.parse(row.config);
  const rt = buildHttpTool({
    name: row.name,
    description: row.description,
    config: cfg,
    sideEffect: cfg.method === "GET" ? "read" : "write",
    requiresApproval: false,
    auth: cred ? { authType: cred.authType, secret: await decryptSecret(cred), headerName: (cred.metadata as { headerName?: string }).headerName } : undefined,
  });
  const out = await rt.execute(input, { orgId, workspaceId, agentId: "", executionId: "", signal: AbortSignal.timeout(20_000) });
  res.json({ output: out.forModel, trace: out.forTrace });
});

/** Which published agent versions use this tool (shown before deleting). */
toolsRouter.get("/:id/usage", async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  const rows = await withTenant(orgId, (tx) =>
    tx.select({ agentVersionId: agentVersionTools.agentVersionId }).from(agentVersionTools).where(eq(agentVersionTools.toolId, id)),
  );
  res.json({ versions: rows.length });
});
