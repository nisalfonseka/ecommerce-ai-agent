import { MemoryCommerceProvider } from "@ace/adapter-memory";
import { CommerceError, type SearchProductsInput } from "@ace/contracts";
import { createDb, setSyncState, withTenant } from "@ace/db";
import { createTestDatabase, type TestDatabase } from "@ace/db/testing";
import { createDemoEmbedder, type Embedder } from "@ace/knowledge";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { applyMerchantOverrides } from "./enrich";
import { IndexedCatalogProvider } from "./indexed-provider";
import { indexedStore, NullQueue, newTenantStore } from "./test-fixture";

const testDb = await createTestDatabase();
const DRESS = "p_wrap_dress_black";
const DRESS_VARIANTS = ["p_wrap_dress_black_s", "p_wrap_dress_black_m", "p_wrap_dress_black_l"];

const throwingEmbedder: Embedder = {
  model: "demo:hash-v1",
  async embed() {
    throw new Error("embedding service down");
  },
};

describe.skipIf(testDb === null)("IndexedCatalogProvider", () => {
  let database: TestDatabase;
  let app: ReturnType<typeof createDb>;
  let a: { tenantId: string; storeId: string; embedder: Embedder };

  beforeAll(async () => {
    if (!testDb) return;
    database = testDb;
    app = createDb(database.appUrl);
    a = await indexedStore(app.db);
  });
  afterAll(async () => {
    await app?.close();
    await database?.drop();
  });

  function indexed(
    options: {
      inner?: MemoryCommerceProvider;
      embedder?: Embedder | null;
      store?: { tenantId: string; storeId: string };
      liveConcurrency?: number;
    } = {},
  ) {
    const inner = options.inner ?? new MemoryCommerceProvider();
    const onError = vi.fn();
    const provider = new IndexedCatalogProvider(inner, {
      db: app.db,
      ...(options.store ?? a),
      embedder: options.embedder === undefined ? a.embedder : options.embedder,
      onError,
      liveConcurrency: options.liveConcurrency,
    });
    return { inner, provider, onError };
  }
  const ids = async (provider: IndexedCatalogProvider, input: SearchProductsInput) =>
    (await provider.searchProducts(input)).items.map((item) => item.id);

  describe("relevance", () => {
    it("ranks the black wrap dress first for 'black dress'", async () => {
      const { provider, inner } = indexed();
      const spy = vi.spyOn(inner, "searchProducts");
      expect((await ids(provider, { query: "black dress" }))[0]).toBe(DRESS);
      expect(spy).not.toHaveBeenCalled();
    });

    it("rewrites Singlish and Sinhala before searching", async () => {
      const { provider } = indexed();
      expect((await ids(provider, { query: "kalu gawuma" }))[0]).toBe(DRESS);
      expect((await ids(provider, { query: "කළු ගවුම" }))[0]).toBe(DRESS);
    });

    it("filters by option and returns only the matching variants", async () => {
      const { provider } = indexed();
      const result = await provider.searchProducts({
        query: "shirt",
        filters: { options: { size: ["XL"] } },
      });
      expect(result.items.map((item) => [item.id, item.matchingVariantIds])).toEqual([
        ["p_oxford_shirt_white", ["p_oxford_shirt_white_xl"]],
      ]);
    });

    it("filters by category through the effective attributes", async () => {
      const { provider } = indexed();
      const found = await ids(provider, { query: "black", filters: { category: "Dress" } });
      expect(found[0]).toBe(DRESS);
      expect([...found].sort()).toEqual([DRESS, "p_maxi_dress_floral"].sort());
    });

    it("uses the vector leg only for rows embedded with the embedder's model", async () => {
      // No word of this query is in the catalog, so only the vector leg can return anything.
      const { provider } = indexed();
      expect((await ids(provider, { query: "qwertyuiop" })).length).toBeGreaterThan(0);
      const other: Embedder = { model: "demo:other-v2", embed: (v, p) => createDemoEmbedder().embed(v, p) };
      expect(await ids(indexed({ embedder: other }).provider, { query: "qwertyuiop" })).toEqual([]);
    });
  });

  describe("live data is authoritative", () => {
    it("shows a price changed after indexing", async () => {
      const { provider, inner } = indexed();
      inner.setPrice("p_wrap_dress_black_m", 2_222_200);
      const result = await provider.searchProducts({ query: "black dress" });
      const dress = result.items.find((item) => item.id === DRESS);
      expect(dress?.priceRange.max).toEqual({ amount: 2_222_200, currency: "LKR" });
    });

    it("drops a product whose live price is above priceMax", async () => {
      const { provider, inner } = indexed();
      expect(await ids(provider, { query: "black dress", filters: { priceMax: 2_000_000 } })).toContain(
        DRESS,
      );
      for (const id of DRESS_VARIANTS) inner.setPrice(id, 2_500_000);
      expect(await ids(provider, { query: "black dress", filters: { priceMax: 2_000_000 } })).not.toContain(
        DRESS,
      );
    });

    it("recomputes matching variants live for a price range", async () => {
      const { provider, inner } = indexed();
      inner.setPrice("p_wrap_dress_black_l", 2_500_000);
      const result = await provider.searchProducts({
        query: "black dress",
        filters: { priceMax: 2_000_000 },
      });
      expect(result.items.find((item) => item.id === DRESS)?.matchingVariantIds).toEqual([
        "p_wrap_dress_black_s",
        "p_wrap_dress_black_m",
      ]);
    });

    it("drops a product that sold out when inStockOnly", async () => {
      const { provider, inner } = indexed();
      for (const id of DRESS_VARIANTS) inner.setStock(id, 0);
      expect(await ids(provider, { query: "black dress" })).toContain(DRESS);
      expect(await ids(provider, { query: "black dress", filters: { inStockOnly: true } })).not.toContain(
        DRESS,
      );
    });

    it("drops a product the store removed, without an error", async () => {
      const { provider, inner, onError } = indexed();
      inner.removeProduct(DRESS);
      const found = await ids(provider, { query: "black dress" });
      expect(found).not.toContain(DRESS);
      expect(found.length).toBeGreaterThan(0);
      expect(onError).not.toHaveBeenCalled();
    });
  });

  describe("fallbacks", () => {
    it("delegates to the store while the index has never been synced", async () => {
      const store = await newTenantStore(app.db);
      const { provider, inner } = indexed({ store });
      const spy = vi.spyOn(inner, "searchProducts");
      const result = await provider.searchProducts({ query: "black dress" });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(result.items.length).toBeGreaterThan(0);
    });

    it("delegates browsing without query text or filters other than inStockOnly", async () => {
      const { provider, inner } = indexed();
      const spy = vi.spyOn(inner, "searchProducts");
      await provider.searchProducts({});
      await provider.searchProducts({ filters: { inStockOnly: true }, limit: 3 });
      expect(spy).toHaveBeenCalledTimes(2);
      await provider.searchProducts({ filters: { options: { size: ["M"] } } });
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it("searches full-text only when the embedder fails, reporting once", async () => {
      const { provider, onError } = indexed({ embedder: throwingEmbedder });
      expect((await ids(provider, { query: "black dress" }))[0]).toBe(DRESS);
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it("searches full-text only without an embedder", async () => {
      const { provider } = indexed({ embedder: null });
      expect((await ids(provider, { query: "black dress" }))[0]).toBe(DRESS);
      expect(await ids(provider, { query: "qwertyuiop" })).toEqual([]);
    });

    it("skips candidates whose live read fails and reports them", async () => {
      const { provider, inner, onError } = indexed();
      const getProduct = inner.getProduct.bind(inner);
      vi.spyOn(inner, "getProduct").mockImplementation(async (id) => {
        if (id === "p_kurta_navy") throw new CommerceError("UPSTREAM_UNAVAILABLE", "timeout");
        return getProduct(id);
      });
      // Size M: exactly five products.
      const found = await ids(provider, { filters: { options: { size: ["M"] } }, limit: 5 });
      expect(found).toHaveLength(4);
      expect(found).not.toContain("p_kurta_navy");
      expect(onError).toHaveBeenCalledTimes(1);
    });

    it("throws the first error when every live read fails", async () => {
      const { provider, inner } = indexed();
      vi.spyOn(inner, "getProduct").mockRejectedValue(new CommerceError("UPSTREAM_UNAVAILABLE", "down"));
      await expect(
        provider.searchProducts({ filters: { options: { size: ["M"] } }, limit: 5 }),
      ).rejects.toMatchObject({ code: "UPSTREAM_UNAVAILABLE" });
    });

    it("reads live with bounded concurrency", async () => {
      const { provider, inner } = indexed({ liveConcurrency: 2 });
      const getProduct = inner.getProduct.bind(inner);
      let inFlight = 0;
      let peak = 0;
      vi.spyOn(inner, "getProduct").mockImplementation(async (id) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return getProduct(id);
      });
      expect(await ids(provider, { filters: { options: { size: ["M"] } }, limit: 5 })).toHaveLength(5);
      expect(peak).toBe(2);
    });
  });

  describe("isolation", () => {
    it("another tenant's hidden product does not affect this tenant", async () => {
      const b = await indexedStore(app.db);
      await applyMerchantOverrides({ db: app.db, ...b, jobs: new NullQueue() }, DRESS, { hidden: true });
      expect(await ids(indexed().provider, { query: "black dress" })).toContain(DRESS);
      expect(await ids(indexed({ store: b }).provider, { query: "black dress" })).not.toContain(DRESS);
    });

    it("another store of the same tenant sees none of this store's products", async () => {
      const store = await newTenantStore(app.db, a.tenantId);
      await withTenant(app.db, a.tenantId, (tx) =>
        setSyncState(tx, a.tenantId, store.storeId, { status: "ready", lastFullSyncAt: new Date() }),
      );
      const { provider, inner } = indexed({ store });
      const spy = vi.spyOn(inner, "searchProducts");
      expect(await provider.searchProducts({ query: "black dress" })).toEqual({
        items: [],
        nextCursor: null,
      });
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("pagination", () => {
    it("pages without overlap and binds the cursor to the query", async () => {
      const { provider } = indexed();
      const first = await provider.searchProducts({ query: "black", limit: 2 });
      expect(first.items).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const cursor = first.nextCursor ?? undefined;
      const second = await provider.searchProducts({ query: "black", limit: 2, cursor });
      expect(second.items.length).toBeGreaterThan(0);
      const firstIds = first.items.map((item) => item.id);
      for (const item of second.items) expect(firstIds).not.toContain(item.id);
      await expect(provider.searchProducts({ query: "white", limit: 2, cursor })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });
      await expect(
        provider.searchProducts({ query: "black", limit: 2, cursor, filters: { inStockOnly: true } }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    });

    it("pages a filter-only search", async () => {
      const { provider } = indexed();
      const input = { filters: { options: { size: ["M"] } }, limit: 3 };
      const first = await provider.searchProducts(input);
      const second = await provider.searchProducts({ ...input, cursor: first.nextCursor ?? undefined });
      const all = [...first.items, ...second.items].map((item) => item.id);
      expect(new Set(all).size).toBe(5);
      expect(second.nextCursor).toBeNull();
    });
  });

  it("rejects invalid input with INVALID_INPUT and delegates every other method", async () => {
    const { provider, inner } = indexed();
    await expect(provider.searchProducts({ limit: 500 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(provider.platform).toBe(inner.platform);
    expect(provider.capabilities).toBe(inner.capabilities);
    expect(await provider.getProduct(DRESS)).toEqual(await inner.getProduct(DRESS));
  });
});
