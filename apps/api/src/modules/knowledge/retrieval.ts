import { and, inArray, isNull, sql } from "drizzle-orm";
import { withTenant } from "@we360/db";
import { knowledgeBases } from "@we360/db/schema";
import { logger } from "../../lib/logger";
import { embedTexts } from "../models/gateway";
import { recordUsage } from "../usage/usage.service";

export interface RetrievedChunk {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  content: string;
  score: number;
  metadata: { headingPath?: string[]; page?: number };
}

const RRF_K = 60;
const CANDIDATES = 40;

/**
 * Hybrid search: pgvector cosine similarity + Postgres full-text, fused with
 * Reciprocal Rank Fusion. Runs under RLS, so only the tenant's chunks are visible;
 * the knowledge_base_id filter limits it further to the agent's linked KBs.
 *
 * Vectors are only comparable within one embedding model, so knowledge bases are grouped
 * by the model they were built with and the query is embedded once per group.
 */
export async function searchKnowledge(opts: {
  orgId: string;
  knowledgeBaseIds: string[];
  query: string;
  topK: number;
  agentId?: string;
  executionId?: string;
}): Promise<RetrievedChunk[]> {
  if (opts.knowledgeBaseIds.length === 0 || !opts.query.trim()) return [];

  const kbs = await withTenant(opts.orgId, (tx) =>
    tx
      .select({ id: knowledgeBases.id, embeddingModel: knowledgeBases.embeddingModel })
      .from(knowledgeBases)
      .where(and(inArray(knowledgeBases.id, opts.knowledgeBaseIds), isNull(knowledgeBases.deletedAt))),
  );
  const groups = new Map<string, string[]>();
  for (const kb of kbs) groups.set(kb.embeddingModel, [...(groups.get(kb.embeddingModel) ?? []), kb.id]);

  const results: RetrievedChunk[] = [];
  for (const [modelRef, kbIds] of groups) {
    const emb = await embedTexts(opts.orgId, [opts.query], { preferredRef: modelRef, purpose: "query" });
    if (emb.model) {
      await recordUsage({
        orgId: opts.orgId,
        agentId: opts.agentId,
        executionId: opts.executionId,
        model: emb.model,
        kind: "embedding",
        billingSource: emb.billingSource,
        inputTokens: emb.tokens,
        outputTokens: 0,
      });
    }
    if (emb.modelRef !== modelRef && modelRef !== "mock:mock") {
      // The KB's model isn't usable anymore; results fall back to keyword matching quality until re-processed.
      logger.warn({ orgId: opts.orgId, kbIds, modelRef, used: emb.modelRef }, "knowledge base embedded with a different model");
    }
    results.push(...(await hybridSearch(opts.orgId, kbIds, opts.query, emb.embeddings[0]!, opts.topK)));
  }
  return results.sort((a, b) => b.score - a.score).slice(0, opts.topK);
}

async function hybridSearch(orgId: string, knowledgeBaseIds: string[], query: string, embedding: number[], topK: number): Promise<RetrievedChunk[]> {
  const vector = `[${embedding.join(",")}]`;
  const kbIds = sql`array[${sql.join(
    knowledgeBaseIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  )}]`;

  return withTenant(orgId, async (tx) => {
    const result = await tx.execute<{
      chunk_id: string;
      document_id: string;
      title: string;
      content: string;
      metadata: RetrievedChunk["metadata"];
      score: number;
    }>(sql`
      with vec as (
        select c.id, row_number() over (order by c.embedding <=> ${vector}::vector) as r
        from document_chunks c
        where c.knowledge_base_id = any(${kbIds})
        order by c.embedding <=> ${vector}::vector
        limit ${CANDIDATES}
      ),
      fts as (
        select c.id, row_number() over (order by ts_rank(c.tsv, q) desc) as r
        from document_chunks c, plainto_tsquery('simple', ${query}) q
        where c.knowledge_base_id = any(${kbIds}) and c.tsv @@ q
        order by ts_rank(c.tsv, q) desc
        limit ${CANDIDATES}
      ),
      fused as (
        select id, sum(1.0 / (${RRF_K} + r)) as score
        from (select * from vec union all select * from fts) x
        group by id
      )
      select c.id as chunk_id, d.id as document_id, d.title, c.content, c.metadata, f.score::float as score
      from fused f
      join document_chunks c on c.id = f.id
      join documents d on d.id = c.document_id and d.deleted_at is null and d.status = 'ready'
      order by f.score desc
      limit ${topK}
    `);
    return result.rows.map((r) => ({
      chunkId: r.chunk_id,
      documentId: r.document_id,
      documentTitle: r.title,
      content: r.content,
      score: Number(r.score),
      metadata: r.metadata ?? {},
    }));
  });
}
