import { CommerceError, type CommerceProvider, type Product } from "@ace/contracts";
import {
  type CatalogProductRow,
  type CatalogVariantInsert,
  type Db,
  getCatalogProduct,
  getCatalogVariants,
  getSyncState,
  markMissingDeleted,
  markProductDeleted,
  setSyncState,
  type Tx,
  upsertCatalogProduct,
  withTenant,
} from "@ace/db";
import { JOBS, type JobQueue } from "@ace/db/jobs";
import { embeddingHash, embeddingText, productRows } from "./rows";
import { stableJson } from "./stable-json";

export interface SyncDeps {
  db: Db;
  tenantId: string;
  storeId: string;
  provider: CommerceProvider;
  jobs: JobQueue;
  embeddingModel: string;
  now?: () => Date;
}

export type SyncOutcome = "created" | "updated" | "unchanged" | "deleted" | "missing";

const PAGE_SIZE = 100;
/** Overlap so a product updated while the previous sync ran is not missed (clocks, in-flight writes). */
const WATERMARK_OVERLAP_MS = 5 * 60 * 1000;

type FollowUp = "enrich" | "embed";

const variantFingerprint = (
  variants: Pick<
    CatalogVariantInsert,
    "variantId" | "title" | "options" | "price" | "currency" | "availability"
  >[],
) =>
  JSON.stringify(
    variants
      .map((v) => [v.variantId, v.title, stableJson(v.options), v.price, v.currency, v.availability])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  );

type Fingerprinted = Pick<
  CatalogProductRow,
  | "handle"
  | "title"
  | "description"
  | "url"
  | "category"
  | "tags"
  | "platformAttributes"
  | "attributes"
  | "imageUrl"
  | "currency"
  | "minPrice"
  | "maxPrice"
  | "availability"
  | "searchPrimary"
  | "searchSecondary"
  | "contentHash"
> & { sourceUpdatedAt?: Date | null };

const productFingerprint = (row: Fingerprinted) =>
  JSON.stringify([
    row.handle,
    row.title,
    row.description,
    row.url,
    row.category,
    row.tags,
    stableJson(row.platformAttributes),
    stableJson(row.attributes),
    row.imageUrl,
    row.currency,
    row.minPrice,
    row.maxPrice,
    row.availability,
    row.searchPrimary,
    row.searchSecondary,
    row.sourceUpdatedAt?.getTime() ?? null,
    row.contentHash,
  ]);

/** Writes one live product inside the caller's transaction and says which jobs to enqueue afterwards. */
async function applyProduct(
  tx: Tx,
  deps: SyncDeps,
  product: Product,
  backfill: boolean,
): Promise<{ outcome: SyncOutcome; followUp: FollowUp | null }> {
  const existing = await getCatalogProduct(tx, deps.storeId, product.id);
  const incoming = Date.parse(product.updatedAt);
  if (existing?.sourceUpdatedAt && incoming < existing.sourceUpdatedAt.getTime()) {
    return { outcome: "unchanged", followUp: null };
  }
  const rows = productRows(deps.storeId, product, existing ?? undefined);
  let outcome: SyncOutcome = "created";
  if (existing) {
    const variants = await getCatalogVariants(tx, deps.storeId, product.id);
    const same =
      existing.status === "active" &&
      productFingerprint(existing) === productFingerprint(rows.product as Fingerprinted) &&
      variantFingerprint(variants) === variantFingerprint(rows.variants);
    outcome = same ? "unchanged" : "updated";
  }
  if (outcome !== "unchanged" && !(await upsertCatalogProduct(tx, deps.tenantId, rows))) {
    // A concurrent sync stored a newer version between our read and write.
    return { outcome: "unchanged", followUp: null };
  }

  const contentChanged = !existing || existing.contentHash !== rows.product.contentHash;
  if (contentChanged) {
    return { outcome, followUp: "enrich" };
  }
  // Only a full reconcile backfills: it repairs an enrich job lost after the row committed (R11).
  if (backfill && existing && existing.enriched === null) {
    return { outcome, followUp: "enrich" };
  }
  // Embedding follows enrichment, which enqueues it itself; only enriched rows can be re-embedded here.
  if (existing && existing.enriched !== null) {
    const hash = embeddingHash(
      embeddingText({
        title: product.title,
        category: product.category ?? null,
        attributes: rows.product.attributes as Record<string, string[]>,
        tags: product.tags,
        description: product.description,
      }),
    );
    if (existing.embeddedHash !== hash || existing.embeddingModel !== deps.embeddingModel) {
      return { outcome, followUp: "embed" };
    }
  }
  return { outcome, followUp: null };
}

async function enqueue(deps: SyncDeps, productId: string, followUp: FollowUp | null): Promise<void> {
  if (!followUp) return;
  const name = followUp === "enrich" ? JOBS.enrichProduct : JOBS.embedProduct;
  await deps.jobs.send(name, { tenantId: deps.tenantId, storeId: deps.storeId, productId });
}

/**
 * Live getProduct (outside any transaction) → upsert product + replace variants in one withTenant
 * transaction, or mark deleted when the store no longer has it. Jobs are sent after commit.
 */
export async function syncProduct(deps: SyncDeps, productId: string): Promise<SyncOutcome> {
  const product = await deps.provider.getProduct(productId);
  const result = await withTenant(
    deps.db,
    deps.tenantId,
    async (tx): Promise<{ outcome: SyncOutcome; followUp: FollowUp | null }> => {
      if (product) return applyProduct(tx, deps, product, false);
      const existing = await getCatalogProduct(tx, deps.storeId, productId);
      if (!existing) return { outcome: "missing", followUp: null };
      if (existing.status === "deleted") return { outcome: "unchanged", followUp: null };
      await markProductDeleted(tx, deps.storeId, productId);
      return { outcome: "deleted", followUp: null };
    },
  );
  await enqueue(deps, productId, result.followUp);
  return result.outcome;
}

function errorCode(error: unknown): string {
  if (error instanceof CommerceError) return error.code;
  return error instanceof Error ? error.name : "UNKNOWN";
}

/**
 * Pages listProducts. Incremental starts 5 minutes before the watermark; full lists everything and then
 * marks every active product it did not see as deleted. A failure is recorded (code only) and rethrown so
 * the job retries; pages already written are kept.
 */
export async function reconcileStore(
  deps: SyncDeps,
  options: { full: boolean },
): Promise<{ seen: number; changed: number; deleted: number }> {
  const now = deps.now ?? (() => new Date());
  const state = await withTenant(deps.db, deps.tenantId, async (tx) => {
    const current = await getSyncState(tx, deps.storeId);
    await setSyncState(tx, deps.tenantId, deps.storeId, { status: "syncing" });
    return current;
  });
  const updatedSince =
    !options.full && state?.watermark
      ? new Date(state.watermark.getTime() - WATERMARK_OVERLAP_MS).toISOString()
      : undefined;

  const seenIds: string[] = [];
  let changed = 0;
  let maxUpdated = state?.watermark ?? null;
  try {
    let cursor: string | undefined;
    do {
      const page = await deps.provider.listProducts({ updatedSince, limit: PAGE_SIZE, cursor });
      const results = await withTenant(deps.db, deps.tenantId, async (tx) => {
        const out: { id: string; outcome: SyncOutcome; followUp: FollowUp | null }[] = [];
        for (const product of page.items) {
          out.push({ id: product.id, ...(await applyProduct(tx, deps, product, options.full)) });
        }
        return out;
      });
      for (const result of results) {
        seenIds.push(result.id);
        if (result.outcome !== "unchanged") changed += 1;
        await enqueue(deps, result.id, result.followUp);
      }
      for (const product of page.items) {
        const updated = new Date(product.updatedAt);
        if (!maxUpdated || updated > maxUpdated) maxUpdated = updated;
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    const deleted = options.full
      ? await withTenant(deps.db, deps.tenantId, (tx) => markMissingDeleted(tx, deps.storeId, seenIds))
      : 0;
    const finished = now();
    await withTenant(deps.db, deps.tenantId, (tx) =>
      setSyncState(tx, deps.tenantId, deps.storeId, {
        status: "ready",
        lastError: null,
        watermark: maxUpdated,
        ...(options.full ? { lastFullSyncAt: finished } : { lastIncrementalSyncAt: finished }),
      }),
    );
    return { seen: seenIds.length, changed, deleted };
  } catch (error) {
    // A failed full sync leaves the index usable only if an earlier full sync completed.
    const keepReady = options.full && state?.lastFullSyncAt != null;
    await withTenant(deps.db, deps.tenantId, (tx) =>
      setSyncState(tx, deps.tenantId, deps.storeId, {
        status: keepReady ? "ready" : "error",
        lastError: errorCode(error),
      }),
    );
    throw error;
  }
}
