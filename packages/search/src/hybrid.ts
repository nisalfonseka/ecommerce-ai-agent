import type { SearchFilters } from "@ace/contracts";
import { schema, type Tx } from "@ace/db";
import { type SQL, sql } from "drizzle-orm";
import { tokenize } from "./query";

export interface HybridQuery {
  storeId: string;
  /** Normalised query text (normalizeQuery); undefined or empty → filters only. */
  text: string | undefined;
  filters: SearchFilters;
  /** Query vector for `embeddingModel`; null → full-text only. */
  queryEmbedding: number[] | null;
  embeddingModel: string;
  limit: number;
  offset: number;
}

export interface Candidate {
  productId: string;
  score: number;
  /** Indexed variants that passed the filters (the caller recomputes them on live data). */
  matchingVariantIds: string[];
}

/** Candidates per leg before fusion. */
const LEG_LIMIT = 50;
/** Reciprocal rank fusion constant. */
const RRF_K = 60;

interface LegRow extends Record<string, unknown> {
  product_id: string;
  boost: number;
  variant_ids: string[];
  /** Best availability among the matching variants: 0 in_stock, 1 low_stock, 2 backorder, 3 out_of_stock. */
  availability_rank: number;
}

const p = schema.catalogProducts;
const v = schema.catalogVariants;

function variantConditions(filters: SearchFilters): SQL[] {
  const conditions: SQL[] = [];
  // option_keys holds lowercased "name:value"; any value within a name, every name required.
  for (const [name, values] of Object.entries(filters.options ?? {})) {
    const keys = values.map((value) => sql`${`${name}:${value}`.toLowerCase()}`);
    conditions.push(sql`v.option_keys && array[${sql.join(keys, sql`, `)}]::text[]`);
  }
  if (filters.priceMin !== undefined) conditions.push(sql`v.price >= ${filters.priceMin}`);
  if (filters.priceMax !== undefined) conditions.push(sql`v.price <= ${filters.priceMax}`);
  if (filters.inStockOnly) conditions.push(sql`v.availability <> 'out_of_stock'`);
  return conditions;
}

/**
 * Active, visible products of the store with at least one variant passing the filters. Category matches the
 * store's category or the effective `attributes.category` (enrichment and merchant overrides).
 */
function eligible(storeId: string, filters: SearchFilters): SQL {
  const variantWhere = variantConditions(filters).map((condition) => sql` and ${condition}`);
  const category = filters.category?.trim().toLowerCase();
  const categoryWhere =
    category === undefined || category === ""
      ? sql``
      : sql` and (lower(p.category) = ${category} or p.attributes -> 'category' @> ${JSON.stringify([category])}::jsonb)`;
  return sql`eligible as (
    select p.product_id, p.boost, p.title, p.search_tsv, p.embedding, p.embedding_model,
      m.variant_ids, m.availability_rank
    from ${p} p
    cross join lateral (
      select array_agg(v.variant_id order by v.variant_id) as variant_ids,
        min(case v.availability when 'in_stock' then 0 when 'low_stock' then 1 when 'backorder' then 2 else 3 end)::int
          as availability_rank
      from ${v} v
      where v.tenant_id = p.tenant_id and v.store_id = p.store_id and v.product_id = p.product_id${sql.join(variantWhere)}
    ) m
    where p.store_id = ${storeId} and p.status = 'active' and not p.hidden${categoryWhere}
      and m.variant_ids is not null
  )`;
}

const COLUMNS = sql`e.product_id, e.boost, e.variant_ids, e.availability_rank`;

async function ftsLeg(tx: Tx, q: HybridQuery, text: string): Promise<LegRow[]> {
  // The English query ANDs every word (stemmed); the OR of the plain words keeps partial matches (a Singlish
  // word the lexicon does not know must not empty the result). Terms are letters/marks/digits only, quoted.
  const anyTerm = tokenize(text)
    .map((term) => `'${term}'`)
    .join(" | ");
  const result = await tx.execute<LegRow>(sql`with ${eligible(q.storeId, q.filters)},
    query as (select websearch_to_tsquery('english', ${text}) || to_tsquery('simple', ${anyTerm}) as q)
    select ${COLUMNS} from eligible e, query
    where e.search_tsv @@ query.q
    order by ts_rank_cd(e.search_tsv, query.q) desc, e.product_id
    limit ${LEG_LIMIT}`);
  return result.rows;
}

async function vectorLeg(tx: Tx, q: HybridQuery, embedding: number[]): Promise<LegRow[]> {
  // Exact cosine search (no ANN index): per-store catalogs are small, and an HNSW scan filtered by tenant and
  // store loses recall (ADR-008). Rows embedded with another model are not comparable and are skipped.
  const result = await tx.execute<LegRow>(sql`with ${eligible(q.storeId, q.filters)}
    select ${COLUMNS} from eligible e
    where e.embedding_model = ${q.embeddingModel} and e.embedding is not null
    order by e.embedding <=> ${JSON.stringify(embedding)}::vector, e.product_id
    limit ${LEG_LIMIT}`);
  return result.rows;
}

async function browse(tx: Tx, q: HybridQuery): Promise<{ candidates: Candidate[]; hasMore: boolean }> {
  const result = await tx.execute<LegRow>(sql`with ${eligible(q.storeId, q.filters)}
    select ${COLUMNS} from eligible e
    order by e.boost desc, e.availability_rank, e.title, e.product_id
    limit ${q.limit + 1} offset ${q.offset}`);
  const rows = result.rows.slice(0, q.limit);
  return {
    candidates: rows.map((row, index) => ({
      productId: row.product_id,
      score: 1 / (RRF_K + q.offset + index + 1),
      matchingVariantIds: row.variant_ids,
    })),
    hasMore: result.rows.length > q.limit,
  };
}

/** score = Σ 1/(60 + rank), halved when every matching variant is out of stock, plus 0.01 × boost. */
function fuse(legs: LegRow[][]): Candidate[] {
  const fused = new Map<string, { row: LegRow; rrf: number }>();
  for (const leg of legs) {
    leg.forEach((row, index) => {
      const entry = fused.get(row.product_id) ?? { row, rrf: 0 };
      entry.rrf += 1 / (RRF_K + index + 1);
      fused.set(row.product_id, entry);
    });
  }
  return [...fused.values()]
    .map(({ row, rrf }) => ({
      productId: row.product_id,
      score: rrf * (row.availability_rank === 3 ? 0.5 : 1) + 0.01 * row.boost,
      matchingVariantIds: row.variant_ids,
    }))
    .sort(
      (a, b) => b.score - a.score || (a.productId < b.productId ? -1 : a.productId > b.productId ? 1 : 0),
    );
}

/**
 * Candidates from the read model: discovery only, never prices or stock. With text, one SQL statement per leg
 * (full-text, and vector when there is a query embedding), fused with RRF in TS; without text, one statement
 * ordered by boost, availability and title. The caller runs it inside withTenant (RLS) and every statement
 * also filters on the store.
 */
export async function hybridSearch(
  tx: Tx,
  q: HybridQuery,
): Promise<{ candidates: Candidate[]; hasMore: boolean }> {
  const text = q.text?.trim();
  if (!text) return browse(tx, q);
  const legs = [await ftsLeg(tx, q, text)];
  if (q.queryEmbedding) legs.push(await vectorLeg(tx, q, q.queryEmbedding));
  const fused = fuse(legs);
  return {
    candidates: fused.slice(q.offset, q.offset + q.limit),
    hasMore: fused.length > q.offset + q.limit,
  };
}
