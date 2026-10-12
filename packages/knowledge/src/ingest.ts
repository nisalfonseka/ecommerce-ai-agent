import { type Db, getDocument, replaceChunks, setDocumentStatus, withTenant } from "@ace/db";
import { chunkText, MAX_CHUNKS_PER_DOCUMENT } from "./chunk";
import type { Embedder } from "./embedding";

export interface IngestDeps {
  db: Db;
  tenantId: string;
  storeId: string;
  embedder: Embedder;
}

/** Stored on the document when embedding fails; the cause is not stored (it may echo content). */
export const EMBEDDING_FAILED = "embedding_failed";
/** Stored on the document when its text chunks to nothing (e.g. headings only). */
export const DOCUMENT_EMPTY = "empty";
/** Stored on the document when its text chunks to more than MAX_CHUNKS_PER_DOCUMENT chunks. */
export const DOCUMENT_TOO_LARGE = "too_large";

/**
 * The knowledge.ingest job body. Loads the document (its text was extracted at upload), chunks it, embeds
 * the chunks (purpose "document", heading path included) and swaps them in atomically, marking it ready.
 * - "error": embedding failed; status error + "embedding_failed", the previous version's chunks stay.
 * - "empty" / "too_large": the text chunks to nothing, or to more than MAX_CHUNKS_PER_DOCUMENT chunks;
 *   status error + that code without calling the embedder, the previous version's chunks stay. Retrying
 *   cannot help. Uploads refuse such text, so this guards rows stored before the checks (or by other paths).
 * - "missing": the document is gone, is not in this store, or was re-uploaded meanwhile (that upload's own
 *   job ingests the new version).
 * Safe to retry: chunks are replaced, never appended.
 */
export async function ingestDocument(
  deps: IngestDeps,
  documentId: string,
): Promise<"ready" | "error" | "empty" | "too_large" | "missing"> {
  const { db, tenantId, storeId, embedder } = deps;
  const doc = await withTenant(db, tenantId, (tx) => getDocument(tx, storeId, documentId));
  if (!doc) return "missing";
  const chunks = chunkText(doc.content);
  const refused =
    chunks.length === 0
      ? DOCUMENT_EMPTY
      : chunks.length > MAX_CHUNKS_PER_DOCUMENT
        ? DOCUMENT_TOO_LARGE
        : null;
  if (refused) {
    const marked = await withTenant(db, tenantId, (tx) =>
      setDocumentStatus(tx, storeId, documentId, doc.version, { status: "error", error: refused }),
    );
    return marked ? refused : "missing";
  }
  let vectors: number[][];
  try {
    vectors = await embedder.embed(
      chunks.map((chunk) => (chunk.heading ? `${chunk.heading}\n\n${chunk.text}` : chunk.text)),
      "document",
    );
    if (vectors.length !== chunks.length) throw new Error("embedder returned the wrong number of vectors");
  } catch {
    const marked = await withTenant(db, tenantId, (tx) =>
      setDocumentStatus(tx, storeId, documentId, doc.version, { status: "error", error: EMBEDDING_FAILED }),
    );
    return marked ? "error" : "missing";
  }
  const written = await withTenant(db, tenantId, (tx) =>
    replaceChunks(tx, tenantId, storeId, documentId, doc.version, {
      embeddingModel: embedder.model,
      chunks: chunks.map((chunk, i) => ({ ...chunk, embedding: vectors[i] ?? [] })),
    }),
  );
  return written ? "ready" : "missing";
}
