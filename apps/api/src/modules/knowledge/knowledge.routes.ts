import { randomUUID } from "node:crypto";
import { Router } from "express";
import multer from "multer";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { withTenant } from "@we360/db";
import { documentChunks, documents, knowledgeBases } from "@we360/db/schema";
import { AppError } from "../../lib/errors";
import { audit, parse, tenantOf, uuidParam } from "../../lib/http";
import { enqueueFileCleanup, enqueueIngest } from "../../lib/queue";
import { EgressBlockedError } from "../../lib/safe-fetch";
import { deleteObject, documentKey, knowledgeBasePrefix, putObject } from "../../lib/storage";
import { perUserLimit } from "../../lib/rate-limit";
import { requireSession, requireTenant } from "../../middleware/auth";
import { assertWithinLimit, lockAndAssertWithinLimit } from "../usage/usage.service";
import { detectType } from "./parsers";
import { searchKnowledge } from "./retrieval";

export const knowledgeRouter = Router();
// Scoped to its own paths: this router is mounted at /api/v1 alongside others.
knowledgeRouter.use(["/knowledge-bases", "/documents"], requireSession, requireTenant);

const MAX_FILE_BYTES = 20 * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE_BYTES, files: 1 } });

async function loadKb(orgId: string, id: string) {
  const [kb] = await withTenant(orgId, (tx) =>
    tx.select().from(knowledgeBases).where(and(eq(knowledgeBases.id, id), isNull(knowledgeBases.deletedAt))),
  );
  if (!kb) throw AppError.notFound("Knowledge base");
  return kb;
}

knowledgeRouter.get("/knowledge-bases", async (req, res) => {
  const { orgId, workspaceId } = tenantOf(req);
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select({
        id: knowledgeBases.id,
        name: knowledgeBases.name,
        description: knowledgeBases.description,
        updatedAt: knowledgeBases.updatedAt,
        documentCount: sql<number>`count(${documents.id}) filter (where ${documents.deletedAt} is null)::int`,
        readyCount: sql<number>`count(${documents.id}) filter (where ${documents.deletedAt} is null and ${documents.status} = 'ready')::int`,
        sizeBytes: sql<number>`coalesce(sum(${documents.sizeBytes}) filter (where ${documents.deletedAt} is null), 0)::bigint`,
      })
      .from(knowledgeBases)
      .leftJoin(documents, eq(documents.knowledgeBaseId, knowledgeBases.id))
      .where(and(eq(knowledgeBases.workspaceId, workspaceId), isNull(knowledgeBases.deletedAt)))
      .groupBy(knowledgeBases.id)
      .orderBy(desc(knowledgeBases.updatedAt)),
  );
  res.json({ data: rows.map((r) => ({ ...r, sizeBytes: Number(r.sizeBytes) })) });
});

const kbSchema = z.object({ name: z.string().trim().min(1).max(80), description: z.string().max(500).optional() });

knowledgeRouter.post("/knowledge-bases", async (req, res) => {
  const { orgId, workspaceId } = tenantOf(req);
  const body = parse(kbSchema, req.body);
  const [kb] = await withTenant(orgId, (tx) =>
    tx.insert(knowledgeBases).values({ orgId, workspaceId, ...body, createdBy: req.auth!.user.id }).returning(),
  );
  await audit(req, { action: "knowledge_base.created", targetType: "knowledge_base", targetId: kb!.id });
  res.status(201).json(kb);
});

knowledgeRouter.get("/knowledge-bases/:id", async (req, res) => {
  res.json(await loadKb(tenantOf(req).orgId, uuidParam(req, "id")));
});

knowledgeRouter.patch("/knowledge-bases/:id", async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  await loadKb(orgId, id);
  const body = parse(kbSchema.partial(), req.body);
  const [kb] = await withTenant(orgId, (tx) => tx.update(knowledgeBases).set(body).where(eq(knowledgeBases.id, id)).returning());
  res.json(kb);
});

knowledgeRouter.delete("/knowledge-bases/:id", async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  await loadKb(orgId, id);
  await withTenant(orgId, async (tx) => {
    // The knowledge base row stays (soft-deleted) because published versions reference it;
    // its documents, chunks and files are removed now. The purge job removes the row later.
    await tx.update(knowledgeBases).set({ deletedAt: new Date() }).where(eq(knowledgeBases.id, id));
    await tx.delete(documents).where(eq(documents.knowledgeBaseId, id)); // chunks cascade
    await audit(req, { action: "knowledge_base.deleted", targetType: "knowledge_base", targetId: id }, tx);
  });
  await enqueueFileCleanup(knowledgeBasePrefix(orgId, id));
  res.status(204).end();
});

knowledgeRouter.get("/knowledge-bases/:id/documents", async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  await loadKb(orgId, id);
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select({
        id: documents.id,
        title: documents.title,
        sourceType: documents.sourceType,
        sourceUrl: documents.sourceUrl,
        mimeType: documents.mimeType,
        sizeBytes: documents.sizeBytes,
        status: documents.status,
        error: documents.error,
        chunkCount: documents.chunkCount,
        createdAt: documents.createdAt,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .where(and(eq(documents.knowledgeBaseId, id), isNull(documents.deletedAt)))
      .orderBy(desc(documents.createdAt)),
  );
  res.json({ data: rows });
});

async function createDocument(
  req: Parameters<typeof tenantOf>[0],
  kbId: string,
  values: { sourceType: "file" | "text" | "url"; title: string; mimeType?: string; sizeBytes: number; sourceUrl?: string },
  bytes?: Buffer,
) {
  const { orgId } = tenantOf(req);
  await assertWithinLimit(orgId, "storage", values.sizeBytes / (1024 * 1024));
  // Store the file first so a storage failure never leaves a document row behind.
  const id = randomUUID();
  const storageKey = bytes ? documentKey(orgId, kbId, id) : undefined;
  if (bytes) await putObject(storageKey!, bytes, values.mimeType ?? "application/octet-stream");
  const [doc] = await withTenant(orgId, async (tx) => {
    // Re-check under a lock: parallel uploads must not all fit into the same remaining space.
    await lockAndAssertWithinLimit(tx, orgId, "storage", values.sizeBytes / (1024 * 1024));
    return tx
      .insert(documents)
      .values({ id, orgId, knowledgeBaseId: kbId, ...values, storageKey, status: "queued", createdBy: req.auth!.user.id })
      .returning();
  }).catch(async (err) => {
    if (storageKey) await deleteObject(storageKey).catch(() => undefined);
    throw err;
  });
  await enqueueIngest({ orgId, documentId: doc!.id });
  await audit(req, { action: "document.added", targetType: "document", targetId: doc!.id });
  return doc!;
}

knowledgeRouter.post("/knowledge-bases/:id/documents", perUserLimit("kb-write", 30), upload.single("file"), async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  await loadKb(orgId, id);
  const file = req.file;
  if (!file) throw AppError.badRequest("Attach a file.");
  if (!detectType(file.mimetype, file.originalname)) {
    throw AppError.badRequest("Unsupported file type. Upload PDF, Word (.docx), TXT, Markdown, CSV, HTML or JSON.");
  }
  const doc = await createDocument(
    req,
    id,
    { sourceType: "file", title: file.originalname.slice(0, 200), mimeType: file.mimetype, sizeBytes: file.size },
    file.buffer,
  );
  res.status(201).json(doc);
});

knowledgeRouter.post("/knowledge-bases/:id/documents/text", perUserLimit("kb-write", 30), async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  await loadKb(orgId, id);
  const body = parse(z.object({ title: z.string().trim().min(1).max(200), text: z.string().min(1).max(500_000) }), req.body);
  const bytes = Buffer.from(body.text, "utf8");
  const doc = await createDocument(req, id, { sourceType: "text", title: body.title, mimeType: "text/markdown", sizeBytes: bytes.length }, bytes);
  res.status(201).json(doc);
});

knowledgeRouter.post("/knowledge-bases/:id/documents/url", perUserLimit("kb-write", 30), async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  await loadKb(orgId, id);
  const { url } = parse(z.object({ url: z.url().max(2000) }), req.body);
  if (!/^https?:\/\//i.test(url)) throw new EgressBlockedError("Only http and https URLs are allowed");
  const doc = await createDocument(req, id, { sourceType: "url", title: url.slice(0, 200), sourceUrl: url, sizeBytes: 0 });
  res.status(201).json(doc);
});

knowledgeRouter.get("/documents/:id/chunks", async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  const rows = await withTenant(orgId, (tx) =>
    tx
      .select({ id: documentChunks.id, ordinal: documentChunks.ordinal, content: documentChunks.content, metadata: documentChunks.metadata, tokenCount: documentChunks.tokenCount })
      .from(documentChunks)
      .where(eq(documentChunks.documentId, id))
      .orderBy(asc(documentChunks.ordinal))
      .limit(50),
  );
  res.json({ data: rows });
});

knowledgeRouter.post("/documents/:id/reindex", perUserLimit("kb-write", 30), async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  const [doc] = await withTenant(orgId, (tx) =>
    tx.update(documents).set({ status: "queued", error: null }).where(and(eq(documents.id, id), isNull(documents.deletedAt))).returning({ id: documents.id }),
  );
  if (!doc) throw AppError.notFound("Document");
  await enqueueIngest({ orgId, documentId: id });
  res.json({ ok: true });
});

knowledgeRouter.delete("/documents/:id", async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  const doc = await withTenant(orgId, async (tx) => {
    // Hard delete: the title and file name can contain personal data. Chunks cascade.
    const [d] = await tx.delete(documents).where(and(eq(documents.id, id), isNull(documents.deletedAt))).returning();
    if (!d) throw AppError.notFound("Document");
    await audit(req, { action: "document.deleted", targetType: "document", targetId: id }, tx);
    return d;
  });
  if (doc.storageKey) await deleteObject(doc.storageKey).catch(() => undefined);
  res.status(204).end();
});

/** Debug search, used by the "Try a search" box on the knowledge base page. */
knowledgeRouter.post("/knowledge-bases/:id/search", perUserLimit("kb-search", 30), async (req, res) => {
  const { orgId } = tenantOf(req);
  const id = uuidParam(req, "id");
  await loadKb(orgId, id);
  const { query } = parse(z.object({ query: z.string().min(1).max(500) }), req.body);
  const chunks = await searchKnowledge({ orgId, knowledgeBaseIds: [id], query, topK: 5 });
  res.json({ data: chunks });
});

