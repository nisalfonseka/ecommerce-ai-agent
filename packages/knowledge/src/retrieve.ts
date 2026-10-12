import { type Db, type KnowledgeSearchRow, searchChunks, withTenant } from "@ace/db";
import { EMBEDDING_DIMENSIONS, type Embedder } from "./embedding";

export const DEFAULT_KNOWLEDGE_THRESHOLD = 0.6;
/** Best of the labelled 20-query demo calibration set (knowledge-calibration.test.ts). */
export const DEMO_THRESHOLD = 0.15;
const RRF_K = 60;

export interface KnowledgePassage {
  documentTitle: string;
  heading: string | null;
  text: string;
  score: number;
}

export interface KnowledgeSearch {
  search(query: string, options?: { limit?: number }): Promise<KnowledgePassage[]>;
}

function qualified(
  vector: KnowledgeSearchRow[],
  fullText: KnowledgeSearchRow[],
  threshold: number,
): Set<string> {
  const bothTopThree = new Set(vector.slice(0, 3).map((row) => row.chunkId));
  const fullTextTopThree = new Set(fullText.slice(0, 3).map((row) => row.chunkId));
  const result = new Set(vector.filter((row) => row.score >= threshold).map((row) => row.chunkId));
  for (const id of bothTopThree) if (fullTextTopThree.has(id)) result.add(id);
  return result;
}

function fuse(
  vector: KnowledgeSearchRow[],
  fullText: KnowledgeSearchRow[],
  threshold: number,
  limit: number,
): KnowledgePassage[] {
  const allowed = qualified(vector, fullText, threshold);
  const fused = new Map<string, { row: KnowledgeSearchRow; score: number }>();
  for (const leg of [vector, fullText]) {
    leg.forEach((row, index) => {
      if (!allowed.has(row.chunkId)) return;
      const current = fused.get(row.chunkId) ?? { row, score: 0 };
      current.score += 1 / (RRF_K + index + 1);
      fused.set(row.chunkId, current);
    });
  }
  return [...fused.values()]
    .sort(
      (a, b) => b.score - a.score || b.row.score - a.row.score || a.row.chunkId.localeCompare(b.row.chunkId),
    )
    .slice(0, limit)
    .map(({ row, score }) => ({
      documentTitle: row.documentTitle,
      heading: row.heading,
      text: row.text,
      score,
    }));
}

export function createKnowledgeSearch(deps: {
  db: Db;
  tenantId: string;
  storeId: string;
  embedder: Embedder;
  threshold?: number;
  onError?: (error: unknown) => void;
}): KnowledgeSearch {
  const threshold =
    deps.threshold ?? (deps.embedder.model === "demo:hash-v1" ? DEMO_THRESHOLD : DEFAULT_KNOWLEDGE_THRESHOLD);
  return {
    async search(query, options) {
      const text = query.trim();
      if (text.length === 0) return [];
      const limit = Math.max(1, Math.floor(options?.limit ?? 3));
      let queryEmbedding: number[] | null = null;
      try {
        const vectors = await deps.embedder.embed([text], "query");
        const vector = vectors[0];
        if (vectors.length !== 1 || vector?.length !== EMBEDDING_DIMENSIONS) {
          throw new Error("embedder returned an invalid query vector");
        }
        queryEmbedding = vector;
      } catch (error) {
        deps.onError?.(error);
      }
      const legs = await withTenant(deps.db, deps.tenantId, (tx) =>
        searchChunks(tx, {
          storeId: deps.storeId,
          query: text,
          queryEmbedding,
          embeddingModel: deps.embedder.model,
        }),
      );
      if (queryEmbedding === null) {
        return legs.fullText
          .filter((row) => row.score >= 0.1)
          .slice(0, limit)
          .map((row) => ({
            documentTitle: row.documentTitle,
            heading: row.heading,
            text: row.text,
            score: row.score,
          }));
      }
      return fuse(legs.vector, legs.fullText, threshold, limit);
    },
  };
}
