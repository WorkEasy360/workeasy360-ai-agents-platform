import { createHash } from "node:crypto";
import { and, eq, isNull, ne } from "drizzle-orm";
import { withTenant } from "@we360/db";
import { documentChunks, documents, knowledgeBases } from "@we360/db/schema";
import { errSummary, logger } from "../../lib/logger";
import { enqueueIngest } from "../../lib/queue";
import { safeFetchBytes } from "../../lib/safe-fetch";
import { getObject, putObject } from "../../lib/storage";
import { embedTexts } from "../models/gateway";
import { recordUsage } from "../usage/usage.service";
import { chunkSections } from "./chunker";
import { UnrecoverableError } from "bullmq";
import { DocumentTooLargeError, detectType, parseDocumentIsolated } from "./parsers";

const EMBED_BATCH = 64;
const MAX_URL_BYTES = 5 * 1024 * 1024;

async function setStatus(orgId: string, documentId: string, values: Partial<typeof documents.$inferInsert>) {
  await withTenant(orgId, (tx) => tx.update(documents).set(values).where(eq(documents.id, documentId)));
}

/** Parse → chunk → embed → store. Runs in the worker; re-running replaces the document's chunks. */
export async function ingestDocument(orgId: string, documentId: string): Promise<void> {
  const loaded = await withTenant(orgId, async (tx) => {
    const [doc] = await tx.select().from(documents).where(eq(documents.id, documentId));
    if (!doc || doc.deletedAt) return undefined;
    const [kb] = await tx.select().from(knowledgeBases).where(eq(knowledgeBases.id, doc.knowledgeBaseId));
    return { doc, kb: kb! };
  });
  if (!loaded) return;
  const { doc, kb } = loaded;

  try {
    await setStatus(orgId, documentId, { status: "parsing", error: null });

    let bytes: Buffer;
    let type: string | undefined;
    if (doc.sourceType === "url" && !doc.storageKey) {
      const fetched = await safeFetchBytes(doc.sourceUrl!, MAX_URL_BYTES);
      bytes = fetched.bytes;
      type = detectType(fetched.contentType, new URL(fetched.finalUrl).pathname) ?? "html";
      const key = `org/${orgId}/kb/${kb.id}/${documentId}`;
      await putObject(key, bytes, fetched.contentType || "text/html");
      await setStatus(orgId, documentId, { storageKey: key, sizeBytes: bytes.length, mimeType: fetched.contentType });
    } else {
      bytes = await getObject(doc.storageKey!);
      type = detectType(doc.mimeType ?? "", doc.title);
    }
    if (!type) throw new Error("Unsupported file type");

    const sections = await parseDocumentIsolated(bytes, type);
    const chunks = chunkSections(sections, kb.chunking.maxTokens, kb.chunking.overlap);
    if (chunks.length === 0) throw new Error("No readable text found in this document. Scanned PDFs aren't supported yet.");

    await setStatus(orgId, documentId, { status: "embedding", contentHash: createHash("sha256").update(bytes).digest("hex") });

    const vectors: number[][] = [];
    let usedRef = kb.embeddingModel;
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      const batch = chunks.slice(i, i + EMBED_BATCH);
      const out = await embedTexts(
        orgId,
        batch.map((c) => c.content),
        { preferredRef: kb.embeddingModel, purpose: "document" },
      );
      usedRef = out.modelRef;
      vectors.push(...out.embeddings);
      if (out.model) {
        await recordUsage({ orgId, model: out.model, kind: "embedding", billingSource: out.billingSource, inputTokens: out.tokens, outputTokens: 0 });
      }
    }

    await withTenant(orgId, async (tx) => {
      await tx.delete(documentChunks).where(eq(documentChunks.documentId, documentId));
      for (let i = 0; i < chunks.length; i += 200) {
        await tx.insert(documentChunks).values(
          chunks.slice(i, i + 200).map((c, j) => ({
            orgId,
            knowledgeBaseId: kb.id,
            documentId,
            ordinal: i + j,
            content: c.content,
            metadata: c.metadata,
            tokenCount: c.tokenCount,
            embedding: vectors[i + j]!,
          })),
        );
      }
      await tx
        .update(documents)
        .set({
          status: "ready",
          chunkCount: chunks.length,
          tokenCount: chunks.reduce((s, c) => s + c.tokenCount, 0),
          error: null,
        })
        .where(eq(documents.id, documentId));
    });

    // The knowledge base switched embedding model (e.g. a different key is now in use):
    // vectors from different models can't be compared, so re-process its other documents.
    if (usedRef !== kb.embeddingModel) {
      const others = await withTenant(orgId, async (tx) => {
        await tx.update(knowledgeBases).set({ embeddingModel: usedRef }).where(eq(knowledgeBases.id, kb.id));
        return tx
          .update(documents)
          .set({ status: "queued" })
          .where(and(eq(documents.knowledgeBaseId, kb.id), ne(documents.id, documentId), isNull(documents.deletedAt)))
          .returning({ id: documents.id });
      });
      for (const d of others) await enqueueIngest({ orgId, documentId: d.id });
    }
  } catch (err) {
    logger.warn({ err: errSummary(err), documentId }, "ingestion failed");
    await setStatus(orgId, documentId, { status: "failed", error: (err as Error).message.slice(0, 500) });
    // Retrying an oversized document would only repeat the same work; fail it once.
    throw err instanceof DocumentTooLargeError ? new UnrecoverableError(err.message) : err;
  }
}
