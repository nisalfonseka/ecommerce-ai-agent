import {
  type AddCartLinesInput,
  type Capability,
  type Cart,
  type CheckoutHandoff,
  type CodDetailsInput,
  type CodQuote,
  type CommerceProvider,
  type CreateCartInput,
  type InventoryLevel,
  type ListOrdersInput,
  type ListProductsInput,
  type ListProductsResult,
  type LookupOrderInput,
  type Order,
  type Product,
  type ProductSummary,
  parseInput,
  type SearchFilters,
  type SearchProductsInput,
  SearchProductsInputSchema,
  type SearchProductsResult,
  summarizeProduct,
  type UpdateCartAttributesInput,
  type UpdateCartLineInput,
  type Variant,
  type WriteOptions,
} from "@ace/contracts";
import { type Db, getSyncState, withTenant } from "@ace/db";
import type { Embedder } from "@ace/knowledge";
import { decodeCursor, encodeCursor } from "./cursor";
import { type Candidate, hybridSearch } from "./hybrid";
import { normalizeQuery, queryFingerprint } from "./query";

export interface IndexedCatalogDeps {
  db: Db;
  tenantId: string;
  storeId: string;
  /** Null → full-text only. */
  embedder: Embedder | null;
  /** Non-fatal problems: embedding failures, live reads that failed for some candidates. */
  onError?: (error: unknown) => void;
  /** Live getProduct calls in flight at once (default 5). */
  liveConcurrency?: number;
}

/** Candidate pages fetched per search when live re-checks drop candidates (bounds latency). */
const MAX_ROUNDS = 3;

/** Same rules as the store's own search: options any-of per name (case-insensitive), price inclusive, stock. */
function variantMatches(variant: Variant, filters: SearchFilters): boolean {
  if (filters.inStockOnly && variant.availability === "out_of_stock") return false;
  if (filters.priceMin !== undefined && variant.price.amount < filters.priceMin) return false;
  if (filters.priceMax !== undefined && variant.price.amount > filters.priceMax) return false;
  const options = new Map(
    Object.entries(variant.options).map(([name, value]) => [name.toLowerCase(), value.toLowerCase()]),
  );
  for (const [name, accepted] of Object.entries(filters.options ?? {})) {
    const actual = options.get(name.toLowerCase());
    if (actual === undefined || !accepted.some((value) => value.toLowerCase() === actual)) return false;
  }
  return true;
}

function hasFilters(filters: SearchFilters): boolean {
  return (
    filters.category !== undefined ||
    Object.keys(filters.options ?? {}).length > 0 ||
    filters.priceMin !== undefined ||
    filters.priceMax !== undefined
  );
}

/**
 * Serves searchProducts from the search read model, then re-reads every candidate live: prices, availability and
 * variants in the results always come from `inner.getProduct` during the call (AGENTS.md rule 3). The index only
 * chooses and orders candidates. Every other method delegates to `inner`; the contract does not change.
 */
export class IndexedCatalogProvider implements CommerceProvider {
  readonly platform: string;
  readonly capabilities: ReadonlySet<Capability>;
  private readonly liveConcurrency: number;
  private reportedNoEmbedder = false;

  constructor(
    private readonly inner: CommerceProvider,
    private readonly deps: IndexedCatalogDeps,
  ) {
    this.platform = inner.platform;
    this.capabilities = inner.capabilities;
    this.liveConcurrency = Math.max(1, deps.liveConcurrency ?? 5);
  }

  async searchProducts(input: SearchProductsInput): Promise<SearchProductsResult> {
    const query = parseInput(SearchProductsInputSchema, input);
    if (!this.capabilities.has("catalog.search") || !this.capabilities.has("catalog.read")) {
      return this.inner.searchProducts(input);
    }
    const normalized = normalizeQuery(query.query ?? "");
    // Browsing with no query is the store's job (its own order, merchandising).
    if (normalized.text === "" && !hasFilters(query.filters)) return this.inner.searchProducts(input);
    if (!(await this.indexReady())) return this.inner.searchProducts(input);

    const fingerprint = queryFingerprint(query.query, query.filters);
    const startOffset = decodeCursor(query.cursor, fingerprint);
    const queryEmbedding = normalized.text === "" ? null : await this.embedQuery(normalized.text);

    const items: ProductSummary[] = [];
    let offset = startOffset;
    let more = false;
    let attempted = 0;
    const failures: unknown[] = [];
    for (let round = 0; round < MAX_ROUNDS && items.length < query.limit; round++) {
      const page = await withTenant(this.deps.db, this.deps.tenantId, (tx) =>
        hybridSearch(tx, {
          storeId: this.deps.storeId,
          text: normalized.text === "" ? undefined : normalized.text,
          filters: query.filters,
          queryEmbedding,
          embeddingModel: this.deps.embedder?.model ?? "",
          // Over-fetch: the live re-check drops products that changed since indexing.
          limit: query.limit * 2,
          offset,
        }),
      );
      const checked = await this.recheckLive(page.candidates, query.filters, query.limit - items.length);
      items.push(...checked.items);
      attempted += checked.attempted;
      failures.push(...checked.failures);
      offset += checked.consumed;
      more = checked.consumed < page.candidates.length || page.hasMore;
      if (!page.hasMore) break;
    }

    if (failures.length > 0) {
      // Every live read failed: an outage, not a few bad candidates. Do not answer "nothing found".
      if (failures.length === attempted) throw failures[0];
      for (const failure of failures) this.deps.onError?.(failure);
    }
    return { items, nextCursor: more ? encodeCursor({ offset, q: fingerprint }) : null };
  }

  /** Usable once a full sync completed; an incremental sync in progress keeps it usable. */
  private async indexReady(): Promise<boolean> {
    const state = await withTenant(this.deps.db, this.deps.tenantId, (tx) =>
      getSyncState(tx, this.deps.storeId),
    );
    return (
      state !== null &&
      state.lastFullSyncAt !== null &&
      (state.status === "ready" || state.status === "syncing")
    );
  }

  private async embedQuery(text: string): Promise<number[] | null> {
    if (!this.deps.embedder) {
      if (!this.reportedNoEmbedder) {
        this.reportedNoEmbedder = true;
        this.deps.onError?.(new Error("No embedder for indexed search; using full-text only."));
      }
      return null;
    }
    try {
      return (await this.deps.embedder.embed([text], "query"))[0] ?? null;
    } catch (error) {
      this.deps.onError?.(error);
      return null;
    }
  }

  /**
   * getProduct for candidates in rank order, `liveConcurrency` at a time, until `wanted` products survive.
   * `consumed` counts the candidates the page used, so the next page starts right after the last one shown.
   */
  private async recheckLive(
    candidates: Candidate[],
    filters: SearchFilters,
    wanted: number,
  ): Promise<{ items: ProductSummary[]; consumed: number; attempted: number; failures: unknown[] }> {
    const items: ProductSummary[] = [];
    const failures: unknown[] = [];
    let consumed = 0;
    let attempted = 0;
    for (let start = 0; start < candidates.length && items.length < wanted; start += this.liveConcurrency) {
      const batch = candidates.slice(start, start + this.liveConcurrency);
      const settled = await Promise.allSettled(batch.map((c) => this.inner.getProduct(c.productId)));
      for (const [index, outcome] of settled.entries()) {
        if (items.length >= wanted) break;
        consumed = start + index + 1;
        attempted += 1;
        if (outcome.status === "rejected") {
          failures.push(outcome.reason);
          continue;
        }
        const summary = outcome.value ? liveSummary(outcome.value, filters) : null;
        if (summary) items.push(summary);
      }
    }
    return { items, consumed, attempted, failures };
  }

  getProduct(productId: string): Promise<Product | null> {
    return this.inner.getProduct(productId);
  }
  listProducts(input: ListProductsInput): Promise<ListProductsResult> {
    return this.inner.listProducts(input);
  }
  getInventory(variantIds: string[]): Promise<InventoryLevel[]> {
    return this.inner.getInventory(variantIds);
  }
  createCart(input: CreateCartInput, opts: WriteOptions): Promise<Cart> {
    return this.inner.createCart(input, opts);
  }
  getCart(cartId: string): Promise<Cart | null> {
    return this.inner.getCart(cartId);
  }
  addCartLines(cartId: string, input: AddCartLinesInput, opts: WriteOptions): Promise<Cart> {
    return this.inner.addCartLines(cartId, input, opts);
  }
  updateCartLine(cartId: string, input: UpdateCartLineInput, opts: WriteOptions): Promise<Cart> {
    return this.inner.updateCartLine(cartId, input, opts);
  }
  updateCartAttributes(cartId: string, input: UpdateCartAttributesInput, opts: WriteOptions): Promise<Cart> {
    return this.inner.updateCartAttributes(cartId, input, opts);
  }
  createCheckout(cartId: string, opts: WriteOptions): Promise<CheckoutHandoff> {
    return this.inner.createCheckout(cartId, opts);
  }
  lookupOrder(input: LookupOrderInput): Promise<Order | null> {
    return this.inner.lookupOrder(input);
  }
  listOrders(input: ListOrdersInput): Promise<Order[]> {
    return this.inner.listOrders(input);
  }
  quoteCodOrder(cartId: string, input: CodDetailsInput): Promise<CodQuote> {
    return this.inner.quoteCodOrder(cartId, input);
  }
  placeCodOrder(cartId: string, input: CodDetailsInput, opts: WriteOptions): Promise<Order> {
    return this.inner.placeCodOrder(cartId, input, opts);
  }
}

/** The summary from live data only; null when no live variant passes the filters. */
function liveSummary(product: Product, filters: SearchFilters): ProductSummary | null {
  const matching = product.variants.filter((variant) => variantMatches(variant, filters)).map((v) => v.id);
  return matching.length > 0 ? summarizeProduct(product, matching) : null;
}
