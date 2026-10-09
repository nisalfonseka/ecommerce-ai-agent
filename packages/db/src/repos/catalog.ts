import { and, asc, eq, getTableColumns, gt, notInArray, sql } from "drizzle-orm";
import type { Tx } from "../client";
import { catalogProducts, catalogSyncState, catalogVariants } from "../schema";

/** Fields the sync computes; identity (tenant, id) and enrichment/embedding state are owned by the repo. */
type ProductInsert = typeof catalogProducts.$inferInsert;
export type CatalogProductInsert = Omit<
  ProductInsert,
  | "id"
  | "tenantId"
  | "createdAt"
  | "syncedAt"
  | "status"
  | "hidden"
  | "boost"
  | "enriched"
  | "overrides"
  | "enrichedHash"
  | "enrichmentModel"
  | "embeddedHash"
  | "embeddingModel"
  | "embedding"
> & { enriched?: unknown; overrides?: unknown };
export type CatalogVariantInsert = Omit<typeof catalogVariants.$inferInsert, "id" | "tenantId" | "createdAt">;
export interface CatalogRows {
  product: CatalogProductInsert;
  variants: CatalogVariantInsert[];
}

const { embedding: _embedding, searchTsv: _searchTsv, ...PRODUCT_COLUMNS } = getTableColumns(catalogProducts);
/** Everything except the (large) embedding vector and the generated tsvector. */
export type CatalogProductRow = Omit<typeof catalogProducts.$inferSelect, "embedding" | "searchTsv">;
export type CatalogVariantRow = typeof catalogVariants.$inferSelect;
export type SyncStateRow = typeof catalogSyncState.$inferSelect;

/**
 * Inserts or refreshes the synced fields of a product and replaces its variants. `enriched`, `overrides`
 * and the enrichment/embedding columns survive a re-sync (the caller passes the existing `enriched` and
 * `overrides` back in so the effective attributes stay correct). A deleted product becomes active again.
 * A write whose source_updated_at is older than the stored one is ignored (a slow reconcile page must not
 * overwrite a fresher webhook sync); returns false then, and the variants are left alone too.
 */
export async function upsertCatalogProduct(tx: Tx, tenantId: string, rows: CatalogRows): Promise<boolean> {
  const { enriched, overrides, ...synced } = rows.product;
  const values = { ...synced, tenantId, status: "active", syncedAt: new Date() };
  const written = await tx
    .insert(catalogProducts)
    .values({ ...values, enriched: enriched ?? null, overrides: overrides ?? {} })
    .onConflictDoUpdate({
      target: [catalogProducts.tenantId, catalogProducts.storeId, catalogProducts.productId],
      set: values,
      setWhere: sql`${catalogProducts.sourceUpdatedAt} is null or excluded.source_updated_at >= ${catalogProducts.sourceUpdatedAt}`,
    })
    .returning({ id: catalogProducts.id });
  if (written.length === 0) return false;
  await tx
    .delete(catalogVariants)
    .where(
      and(
        eq(catalogVariants.storeId, rows.product.storeId),
        eq(catalogVariants.productId, rows.product.productId),
      ),
    );
  if (rows.variants.length > 0) {
    await tx.insert(catalogVariants).values(rows.variants.map((variant) => ({ ...variant, tenantId })));
  }
  return true;
}

/** Variants are kept for history; search filters on products.status. */
export async function markProductDeleted(tx: Tx, storeId: string, productId: string): Promise<void> {
  await tx
    .update(catalogProducts)
    .set({ status: "deleted", syncedAt: new Date() })
    .where(and(eq(catalogProducts.storeId, storeId), eq(catalogProducts.productId, productId)));
}

/** Marks every active product not in `seenIds` as deleted; returns how many changed. */
export async function markMissingDeleted(tx: Tx, storeId: string, seenIds: string[]): Promise<number> {
  const conditions = [eq(catalogProducts.storeId, storeId), eq(catalogProducts.status, "active")];
  if (seenIds.length > 0) conditions.push(notInArray(catalogProducts.productId, seenIds));
  const changed = await tx
    .update(catalogProducts)
    .set({ status: "deleted", syncedAt: new Date() })
    .where(and(...conditions))
    .returning({ id: catalogProducts.id });
  return changed.length;
}

export async function getCatalogProduct(
  tx: Tx,
  storeId: string,
  productId: string,
): Promise<CatalogProductRow | null> {
  const [row] = await tx
    .select(PRODUCT_COLUMNS)
    .from(catalogProducts)
    .where(and(eq(catalogProducts.storeId, storeId), eq(catalogProducts.productId, productId)));
  return row ?? null;
}

export async function getCatalogVariants(
  tx: Tx,
  storeId: string,
  productId: string,
): Promise<CatalogVariantRow[]> {
  return tx
    .select()
    .from(catalogVariants)
    .where(and(eq(catalogVariants.storeId, storeId), eq(catalogVariants.productId, productId)))
    .orderBy(catalogVariants.variantId);
}

export async function getSyncState(tx: Tx, storeId: string): Promise<SyncStateRow | null> {
  const [row] = await tx.select().from(catalogSyncState).where(eq(catalogSyncState.storeId, storeId));
  return row ?? null;
}

export type SyncStatePatch = Partial<
  Pick<SyncStateRow, "status" | "lastFullSyncAt" | "lastIncrementalSyncAt" | "watermark" | "lastError">
>;

export async function setSyncState(
  tx: Tx,
  tenantId: string,
  storeId: string,
  patch: SyncStatePatch,
): Promise<void> {
  const values = { ...patch, updatedAt: new Date() };
  await tx
    .insert(catalogSyncState)
    .values({ tenantId, storeId, ...values })
    .onConflictDoUpdate({ target: catalogSyncState.storeId, set: values });
}

export interface CatalogCounts {
  active: number;
  deleted: number;
  enriched: number;
  embedded: number;
  /** Active, enriched products whose embedding is missing, out of date, or from another model. */
  staleEmbeddings: number;
}

export async function countCatalog(tx: Tx, storeId: string, embeddingModel?: string): Promise<CatalogCounts> {
  const p = catalogProducts;
  const modelStale =
    embeddingModel === undefined ? sql`false` : sql`${p.embeddingModel} is distinct from ${embeddingModel}`;
  const [row] = await tx
    .select({
      active: sql<number>`count(*) filter (where ${p.status} = 'active')::int`,
      deleted: sql<number>`count(*) filter (where ${p.status} = 'deleted')::int`,
      enriched: sql<number>`count(*) filter (where ${p.status} = 'active' and ${p.enriched} is not null)::int`,
      embedded: sql<number>`count(*) filter (where ${p.status} = 'active' and ${p.embedding} is not null)::int`,
      staleEmbeddings: sql<number>`count(*) filter (where ${p.status} = 'active' and ${p.enriched} is not null and (${p.embedding} is null or ${modelStale}))::int`,
    })
    .from(p)
    .where(eq(p.storeId, storeId));
  return row ?? { active: 0, deleted: 0, enriched: 0, embedded: 0, staleEmbeddings: 0 };
}

export interface EnrichmentWrite {
  /** Flat arrays per key (the shape the attribute merge reads). */
  enriched: Record<string, string[]>;
  enrichedHash: string;
  enrichmentModel: string;
  attributes: Record<string, string[]>;
  searchSecondary: string;
}

export async function setEnrichment(
  tx: Tx,
  storeId: string,
  productId: string,
  write: EnrichmentWrite,
): Promise<void> {
  await tx
    .update(catalogProducts)
    .set(write)
    .where(and(eq(catalogProducts.storeId, storeId), eq(catalogProducts.productId, productId)));
}

export interface OverridesWrite {
  /** Flat attribute overrides; omit to leave the stored ones alone. */
  overrides?: Record<string, string[]>;
  hidden?: boolean;
  boost?: number;
  attributes: Record<string, string[]>;
  searchSecondary: string;
}

/** Returns the updated row, or null when the product is not in this store (or tenant). */
export async function setOverrides(
  tx: Tx,
  storeId: string,
  productId: string,
  write: OverridesWrite,
): Promise<CatalogProductRow | null> {
  const [row] = await tx
    .update(catalogProducts)
    .set(write)
    .where(and(eq(catalogProducts.storeId, storeId), eq(catalogProducts.productId, productId)))
    .returning(PRODUCT_COLUMNS);
  return row ?? null;
}

/** One page of the onboarding review, ordered by product id. */
export async function enrichmentReport(
  tx: Tx,
  storeId: string,
  options: { limit: number; cursor?: string },
): Promise<{ items: CatalogProductRow[]; nextCursor: string | null }> {
  const conditions = [eq(catalogProducts.storeId, storeId), eq(catalogProducts.status, "active")];
  if (options.cursor !== undefined) conditions.push(gt(catalogProducts.productId, options.cursor));
  const rows = await tx
    .select(PRODUCT_COLUMNS)
    .from(catalogProducts)
    .where(and(...conditions))
    .orderBy(asc(catalogProducts.productId))
    .limit(options.limit + 1);
  const items = rows.slice(0, options.limit);
  const last = items[items.length - 1];
  return { items, nextCursor: rows.length > options.limit && last ? last.productId : null };
}
