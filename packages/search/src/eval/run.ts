import { MemoryCommerceProvider } from "@ace/adapter-memory";
import type { SearchProductsInput } from "@ace/contracts";
import type { Db } from "@ace/db";
import type { JobQueue } from "@ace/db/jobs";
import type { Embedder } from "@ace/knowledge";
import { embedStoredProduct } from "../embed-product";
import { type Enricher, enrichStoredProduct } from "../enrich";
import { IndexedCatalogProvider } from "../indexed-provider";
import { reconcileStore } from "../sync";
import { evalSeed } from "./catalog";
import { ndcgAt } from "./ndcg";
import { EVAL_QUERIES } from "./queries";

/** Results scored per query (nDCG@5). */
export const EVAL_K = 5;

export interface RelevanceReport {
  overall: number;
  byLang: Record<string, number>;
  perQuery: { id: string; ndcg: number; top: string[] }[];
}

export interface RelevanceEvalDeps {
  db: Db;
  tenantId: string;
  storeId: string;
  embedder: Embedder;
  enricher: Enricher;
}

const INDEX_CONCURRENCY = 4;

/** The eval runs enrichment and embedding itself, for every product, so follow-up jobs are dropped. */
const noJobs: JobQueue = {
  async send() {},
};

const mean = (values: number[]) =>
  values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length;

/**
 * The real search path over the eval store, which must already be indexed. Any non-fatal search problem (a
 * failed query embedding silently falls back to full-text) fails the eval instead: it would skew the score.
 */
async function searchTop(deps: Omit<RelevanceEvalDeps, "enricher">, input: SearchProductsInput) {
  const errors: unknown[] = [];
  const provider = new IndexedCatalogProvider(new MemoryCommerceProvider({ seed: evalSeed() }), {
    db: deps.db,
    tenantId: deps.tenantId,
    storeId: deps.storeId,
    embedder: deps.embedder,
    onError: (error) => errors.push(error),
  });
  const result = await provider.searchProducts({ ...input, limit: EVAL_K });
  if (errors.length > 0) throw errors[0];
  return result.items;
}

/** Full reconcile of the eval catalog into the (empty) store, then enrichment and embedding of every product. */
export async function indexEvalCatalog(deps: RelevanceEvalDeps): Promise<void> {
  const provider = new MemoryCommerceProvider({ seed: evalSeed() });
  const ids = { db: deps.db, tenantId: deps.tenantId, storeId: deps.storeId };
  await reconcileStore(
    { ...ids, provider, jobs: noJobs, embeddingModel: deps.embedder.model },
    { full: true },
  );
  const productIds = evalSeed().products.map((product) => product.id);
  // A few products at a time: each one is several round trips (and two model calls with live models).
  for (let start = 0; start < productIds.length; start += INDEX_CONCURRENCY) {
    await Promise.all(
      productIds.slice(start, start + INDEX_CONCURRENCY).map(async (productId) => {
        await enrichStoredProduct({ ...ids, enricher: deps.enricher, jobs: noJobs }, productId);
        await embedStoredProduct({ ...ids, embedder: deps.embedder }, productId);
      }),
    );
  }
}

/** Runs every eval query through IndexedCatalogProvider at limit 5 over an indexed eval store, and scores it. */
export async function scoreEvalQueries(deps: Omit<RelevanceEvalDeps, "enricher">): Promise<RelevanceReport> {
  const perQuery: RelevanceReport["perQuery"] = [];
  for (const query of EVAL_QUERIES) {
    const top = (await searchTop(deps, query.input)).map((item) => item.id);
    perQuery.push({ id: query.id, ndcg: ndcgAt(EVAL_K, top, query.relevant), top });
  }
  const byLang: Record<string, number> = {};
  for (const lang of [...new Set(EVAL_QUERIES.map((query) => query.lang))]) {
    const ids = new Set(EVAL_QUERIES.filter((query) => query.lang === lang).map((query) => query.id));
    byLang[lang] = mean(perQuery.filter((row) => ids.has(row.id)).map((row) => row.ndcg));
  }
  return { overall: mean(perQuery.map((row) => row.ndcg)), byLang, perQuery };
}

/**
 * Indexes the eval catalog into the given (empty) store the way production does — full reconcile, then
 * enrichment and embedding of every product — and runs every query through IndexedCatalogProvider at limit 5.
 */
export async function runRelevanceEval(deps: RelevanceEvalDeps): Promise<RelevanceReport> {
  await indexEvalCatalog(deps);
  return scoreEvalQueries(deps);
}

/**
 * Queries for things the store does not sell. Not scored (every eval query has a relevant product); recorded
 * so the owner can see what the vector leg returns without a similarity floor.
 */
export const OFF_CATALOG_PROBES = ["laptop", "gift card", "school shoes"];

/** Top results for each probe; the store must already be indexed (run after runRelevanceEval). */
export async function runOffCatalogProbes(
  deps: Omit<RelevanceEvalDeps, "enricher">,
): Promise<{ query: string; top: string[] }[]> {
  const out: { query: string; top: string[] }[] = [];
  for (const query of OFF_CATALOG_PROBES) {
    out.push({ query, top: (await searchTop(deps, { query })).map((item) => item.id) });
  }
  return out;
}
