import { and, asc, eq, sql } from "drizzle-orm";
import type { Tx } from "../client";
import { knowledgeChunks, knowledgeDocuments } from "../schema";

export type KnowledgeDocumentRow = typeof knowledgeDocuments.$inferSelect;
export type KnowledgeSourceType = "markdown" | "pdf" | "url";
export type KnowledgeDocumentStatus = "pending" | "ready" | "error";

export interface KnowledgeDocumentInput {
  storeId: string;
  title: string;
  sourceType: KnowledgeSourceType;
  sourceUrl: string | null;
  /** Extracted text; chunks are rebuilt from it. */
  content: string;
  contentHash: string;
}

export interface KnowledgeDocumentSummary {
  id: string;
  title: string;
  sourceType: string;
  status: string;
  chunkCount: number;
  version: number;
  updatedAt: Date;
}

const SUMMARY = {
  id: knowledgeDocuments.id,
  title: knowledgeDocuments.title,
  sourceType: knowledgeDocuments.sourceType,
  status: knowledgeDocuments.status,
  chunkCount: knowledgeDocuments.chunkCount,
  version: knowledgeDocuments.version,
  updatedAt: knowledgeDocuments.updatedAt,
};

/**
 * Creates the document, or, when the store already has one with this title, replaces its content and bumps
 * `version` (status back to pending). The previous version's chunks stay searchable until replaceChunks swaps
 * in the new ones. A transaction-scoped advisory lock on (store, title) serialises concurrent uploads of one
 * title, since the table has no unique constraint on it.
 */
export async function createDocument(
  tx: Tx,
  tenantId: string,
  input: KnowledgeDocumentInput,
): Promise<{ id: string; status: string; version: number }> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`knowledge:${input.storeId}:${input.title}`}, 0))`,
  );
  const fields = {
    sourceType: input.sourceType,
    sourceUrl: input.sourceUrl,
    content: input.content,
    contentHash: input.contentHash,
    status: "pending",
    error: null,
    updatedAt: new Date(),
  };
  const [existing] = await tx
    .select({ id: knowledgeDocuments.id })
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.storeId, input.storeId), eq(knowledgeDocuments.title, input.title)))
    .orderBy(asc(knowledgeDocuments.createdAt))
    .limit(1);
  const returning = {
    id: knowledgeDocuments.id,
    status: knowledgeDocuments.status,
    version: knowledgeDocuments.version,
  };
  if (existing) {
    const [updated] = await tx
      .update(knowledgeDocuments)
      .set({ ...fields, version: sql`${knowledgeDocuments.version} + 1` })
      .where(eq(knowledgeDocuments.id, existing.id))
      .returning(returning);
    if (updated) return updated;
  }
  const [created] = await tx
    .insert(knowledgeDocuments)
    .values({ ...fields, tenantId, storeId: input.storeId, title: input.title })
    .returning(returning);
  if (!created) throw new Error("knowledge document insert returned no row");
  return created;
}

export async function getDocument(
  tx: Tx,
  storeId: string,
  documentId: string,
): Promise<KnowledgeDocumentRow | null> {
  const [row] = await tx
    .select()
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.storeId, storeId), eq(knowledgeDocuments.id, documentId)));
  return row ?? null;
}

export async function listDocuments(tx: Tx, storeId: string): Promise<KnowledgeDocumentSummary[]> {
  return tx
    .select(SUMMARY)
    .from(knowledgeDocuments)
    .where(eq(knowledgeDocuments.storeId, storeId))
    .orderBy(asc(knowledgeDocuments.title), asc(knowledgeDocuments.createdAt));
}

/** Chunks go with it (ON DELETE CASCADE). False when the document is not in this store (or tenant). */
export async function deleteDocument(tx: Tx, storeId: string, documentId: string): Promise<boolean> {
  const deleted = await tx
    .delete(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.storeId, storeId), eq(knowledgeDocuments.id, documentId)))
    .returning({ id: knowledgeDocuments.id });
  return deleted.length > 0;
}

export interface KnowledgeChunkWrite {
  seq: number;
  heading: string | null;
  text: string;
  tokenEstimate: number;
  /** EMBEDDING_DIMENSIONS numbers. */
  embedding: number[];
}

/** Rows per INSERT statement, well under Postgres' bind-parameter limit. */
const INSERT_BATCH = 100;

/**
 * Swaps the document's chunks for `chunks` and marks it ready, provided it is still at `version` (a re-upload
 * while this version was being embedded makes these chunks stale; its own job writes the new ones). Run it in
 * one transaction (withTenant does) so readers see either the old chunks or the new ones, never a mix.
 * Returns false when the document is gone or has moved to another version.
 */
export async function replaceChunks(
  tx: Tx,
  tenantId: string,
  storeId: string,
  documentId: string,
  version: number,
  write: { embeddingModel: string; chunks: KnowledgeChunkWrite[] },
): Promise<boolean> {
  const [current] = await tx
    .select({ id: knowledgeDocuments.id })
    .from(knowledgeDocuments)
    .where(
      and(
        eq(knowledgeDocuments.storeId, storeId),
        eq(knowledgeDocuments.id, documentId),
        eq(knowledgeDocuments.version, version),
      ),
    )
    .for("update");
  if (!current) return false;
  await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.documentId, documentId));
  for (let start = 0; start < write.chunks.length; start += INSERT_BATCH) {
    await tx.insert(knowledgeChunks).values(
      write.chunks.slice(start, start + INSERT_BATCH).map((chunk) => ({
        ...chunk,
        tenantId,
        storeId,
        documentId,
        embeddingModel: write.embeddingModel,
      })),
    );
  }
  await tx
    .update(knowledgeDocuments)
    .set({ status: "ready", error: null, chunkCount: write.chunks.length, updatedAt: new Date() })
    .where(eq(knowledgeDocuments.id, documentId));
  return true;
}

/**
 * Sets status (and an error code, never content) when the document is still at `version`, so a failure of an
 * old version's job cannot mark a newer upload as failed. Chunks are left alone.
 */
export async function setDocumentStatus(
  tx: Tx,
  storeId: string,
  documentId: string,
  version: number,
  update: { status: KnowledgeDocumentStatus; error: string | null },
): Promise<boolean> {
  const updated = await tx
    .update(knowledgeDocuments)
    .set({ ...update, updatedAt: new Date() })
    .where(
      and(
        eq(knowledgeDocuments.storeId, storeId),
        eq(knowledgeDocuments.id, documentId),
        eq(knowledgeDocuments.version, version),
      ),
    )
    .returning({ id: knowledgeDocuments.id });
  return updated.length > 0;
}

export interface KnowledgeChunkRow {
  seq: number;
  heading: string | null;
  text: string;
  tokenEstimate: number;
  embeddingModel: string | null;
}

/** The document's chunks in order (no vectors), for the admin view and tests. */
export async function listChunks(tx: Tx, storeId: string, documentId: string): Promise<KnowledgeChunkRow[]> {
  return tx
    .select({
      seq: knowledgeChunks.seq,
      heading: knowledgeChunks.heading,
      text: knowledgeChunks.text,
      tokenEstimate: knowledgeChunks.tokenEstimate,
      embeddingModel: knowledgeChunks.embeddingModel,
    })
    .from(knowledgeChunks)
    .where(and(eq(knowledgeChunks.storeId, storeId), eq(knowledgeChunks.documentId, documentId)))
    .orderBy(asc(knowledgeChunks.seq));
}

/** Cheap per-turn gate used to hide search_knowledge when this store has no searchable documents. */
export async function hasReadyKnowledge(tx: Tx, storeId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: knowledgeDocuments.id })
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.storeId, storeId), eq(knowledgeDocuments.status, "ready")))
    .limit(1);
  return row !== undefined;
}

export interface KnowledgeSearchRow {
  chunkId: string;
  documentTitle: string;
  heading: string | null;
  text: string;
  score: number;
}

export interface KnowledgeChunkSearch {
  vector: KnowledgeSearchRow[];
  fullText: KnowledgeSearchRow[];
}

interface RawSearchRow extends Record<string, unknown> {
  chunk_id: string;
  document_title: string;
  heading: string | null;
  text: string;
  score: number | string;
}

const RETRIEVAL_LEG_LIMIT = 8;

const rows = (result: { rows: RawSearchRow[] }): KnowledgeSearchRow[] =>
  result.rows.map((row) => ({
    chunkId: row.chunk_id,
    documentTitle: row.document_title,
    heading: row.heading,
    text: row.text,
    score: Number(row.score),
  }));

/** Store-filtered vector and full-text legs. RLS supplies the tenant boundary. */
export async function searchChunks(
  tx: Tx,
  input: {
    storeId: string;
    query: string;
    queryEmbedding: number[] | null;
    embeddingModel: string;
  },
): Promise<KnowledgeChunkSearch> {
  const c = knowledgeChunks;
  const d = knowledgeDocuments;
  const fullText = await tx.execute<RawSearchRow>(sql`
    with query as (select websearch_to_tsquery('simple', ${input.query}) as value)
    select c.id as chunk_id, d.title as document_title, c.heading, c.text,
      ts_rank_cd(c.search_tsv, query.value) as score
    from ${c} c
    join ${d} d on d.id = c.document_id and d.tenant_id = c.tenant_id and d.store_id = c.store_id
    cross join query
    where c.store_id = ${input.storeId} and d.status = 'ready' and c.search_tsv @@ query.value
    order by score desc, d.title, c.seq
    limit ${RETRIEVAL_LEG_LIMIT}
  `);
  if (input.queryEmbedding === null) return { vector: [], fullText: rows(fullText) };
  const vector = await tx.execute<RawSearchRow>(sql`
    select c.id as chunk_id, d.title as document_title, c.heading, c.text,
      1 - (c.embedding <=> ${JSON.stringify(input.queryEmbedding)}::vector) as score
    from ${c} c
    join ${d} d on d.id = c.document_id and d.tenant_id = c.tenant_id and d.store_id = c.store_id
    where c.store_id = ${input.storeId} and d.status = 'ready'
      and c.embedding_model = ${input.embeddingModel} and c.embedding is not null
    order by c.embedding <=> ${JSON.stringify(input.queryEmbedding)}::vector, d.title, c.seq
    limit ${RETRIEVAL_LEG_LIMIT}
  `);
  return { vector: rows(vector), fullText: rows(fullText) };
}
