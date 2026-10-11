import { Router } from "express";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { withTenant } from "@we360/db";
import { type AgentConfig, agentTemplates, agents, knowledgeBases, tools } from "@we360/db/schema";
import { AppError } from "../../lib/errors";
import { audit, parse, tenantOf, uuidParam } from "../../lib/http";
import { requireSession, requireTenant } from "../../middleware/auth";
import { parseAgentConfig } from "./agent-config";

/**
 * Custom templates: an organization saves an agent's setup (instructions, model, knowledge,
 * tools, settings) and reuses it when creating new agents. Built-in templates live in agent-config.ts.
 */
export const agentTemplatesRouter = Router();
agentTemplatesRouter.use(requireSession, requireTenant);

export const CUSTOM_TEMPLATE_PREFIX = "custom:";

agentTemplatesRouter.get("/", async (req, res) => {
  const { orgId, workspaceId } = tenantOf(req);
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select({ id: agentTemplates.id, name: agentTemplates.name, description: agentTemplates.description, updatedAt: agentTemplates.updatedAt })
      .from(agentTemplates)
      .where(and(eq(agentTemplates.workspaceId, workspaceId), isNull(agentTemplates.deletedAt)))
      .orderBy(desc(agentTemplates.updatedAt)),
  );
  res.json({ data: rows });
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).optional(),
  /** Save the current draft of this agent as the template. */
  agentId: z.uuid(),
});

agentTemplatesRouter.post("/", async (req, res) => {
  const { orgId, workspaceId } = tenantOf(req);
  const body = parse(createSchema, req.body);
  const row = await withTenant(orgId, async (tx) => {
    const [agent] = await tx.select().from(agents).where(and(eq(agents.id, body.agentId), isNull(agents.deletedAt)));
    if (!agent) throw AppError.notFound("Agent");
    const [created] = await tx
      .insert(agentTemplates)
      .values({
        orgId,
        workspaceId,
        name: body.name,
        description: body.description || agent.description,
        config: parseAgentConfig(agent.draftConfig),
        createdBy: req.auth!.user.id,
      })
      .returning({ id: agentTemplates.id, name: agentTemplates.name, description: agentTemplates.description });
    await audit(req, { action: "agent_template.created", targetType: "agent_template", targetId: created!.id, diff: { fromAgent: body.agentId } }, tx);
    return created!;
  });
  res.status(201).json(row);
});

agentTemplatesRouter.patch("/:id", async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  const body = parse(z.object({ name: z.string().trim().min(1).max(80).optional(), description: z.string().trim().max(500).nullable().optional() }), req.body);
  const [row] = await withTenant(orgId, (tx) =>
    tx
      .update(agentTemplates)
      .set(body)
      .where(and(eq(agentTemplates.id, id), isNull(agentTemplates.deletedAt)))
      .returning({ id: agentTemplates.id, name: agentTemplates.name, description: agentTemplates.description }),
  );
  if (!row) throw AppError.notFound("Template");
  res.json(row);
});

agentTemplatesRouter.delete("/:id", async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  await withTenant(orgId, async (tx) => {
    const [row] = await tx
      .update(agentTemplates)
      .set({ deletedAt: new Date() })
      .where(and(eq(agentTemplates.id, id), isNull(agentTemplates.deletedAt)))
      .returning({ id: agentTemplates.id });
    if (!row) throw AppError.notFound("Template");
    await audit(req, { action: "agent_template.deleted", targetType: "agent_template", targetId: id }, tx);
  });
  res.status(204).end();
});

/**
 * Loads a custom template's config for a new agent. Knowledge bases and tools deleted since the
 * template was saved are dropped, so the new agent never points at something that's gone.
 */
export async function loadCustomTemplate(orgId: string, templateId: string): Promise<{ name: string; description: string | null; config: AgentConfig }> {
  return withTenant(orgId, async (tx) => {
    const [tpl] = await tx.select().from(agentTemplates).where(and(eq(agentTemplates.id, templateId), isNull(agentTemplates.deletedAt)));
    if (!tpl) throw AppError.notFound("Template");
    const config = parseAgentConfig(tpl.config);
    const kbIds = config.knowledge.knowledgeBaseIds;
    const toolIds = config.tools.map((t) => t.toolId);
    const liveKbs = kbIds.length
      ? (await tx.select({ id: knowledgeBases.id }).from(knowledgeBases).where(and(inArray(knowledgeBases.id, kbIds), isNull(knowledgeBases.deletedAt)))).map((r) => r.id)
      : [];
    const liveTools = toolIds.length
      ? (await tx.select({ id: tools.id }).from(tools).where(and(inArray(tools.id, toolIds), isNull(tools.deletedAt)))).map((r) => r.id)
      : [];
    return {
      name: tpl.name,
      description: tpl.description,
      config: {
        ...config,
        knowledge: { ...config.knowledge, knowledgeBaseIds: kbIds.filter((id) => liveKbs.includes(id)) },
        tools: config.tools.filter((t) => liveTools.includes(t.toolId)),
      },
    };
  });
}
