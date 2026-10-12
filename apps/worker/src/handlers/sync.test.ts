import { MemoryCommerceProvider } from "@ace/adapter-memory";
import { createDb, getCatalogProduct, getSyncState, withTenant } from "@ace/db";
import { JOBS } from "@ace/db/jobs";
import { createTestDatabase } from "@ace/db/testing";
import { createDemoEmbedder } from "@ace/knowledge";
import { createDemoEnricher, parseStoreSearchConfig } from "@ace/search";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { capturingLogger, DEMO_SEARCH, fakeJob, newStore, testDeps } from "../testing";
import { handleEmbedProduct } from "./embed";
import { handleEnrichProduct } from "./enrich";
import { handleSyncProduct, handleSyncReconcile, handleSyncReconcileAll } from "./sync";

const testDb = await createTestDatabase();
const SHIRT = "p_linen_shirt_black";

describe.skipIf(testDb === null)("sync, enrich and embed handlers", () => {
  let app: ReturnType<typeof createDb>;

  beforeAll(() => {
    if (testDb) app = createDb(testDb.appUrl);
  });
  afterAll(async () => {
    await app?.close();
    await testDb?.drop();
  });

  it("sync.reconcile-all sends one job per index-mode store and none for live-mode stores", async () => {
    const indexed = [await newStore(app.db), await newStore(app.db)];
    const live = [await newStore(app.db, { mode: "live" }), await newStore(app.db, {})];
    const deps = testDeps(app.db);
    await handleSyncReconcileAll(deps, fakeJob(JOBS.syncReconcileAll, { full: true }));

    const sent = deps.jobs.sent.filter((s) => s.name === JOBS.syncReconcile);
    for (const store of indexed) {
      const forStore = sent.filter((s) => (s.data as { storeId: string }).storeId === store.storeId);
      expect(forStore).toHaveLength(1);
      expect(forStore[0]?.data).toEqual({ ...store, full: true });
      expect(forStore[0]?.options?.debounceKey).toMatch(new RegExp(`^${store.storeId}:`));
    }
    for (const store of live) {
      expect(sent.some((s) => (s.data as { storeId: string }).storeId === store.storeId)).toBe(false);
    }
  });

  it("sync.product and sync.reconcile write the read model from the store's live adapter", async () => {
    const store = await newStore(app.db);
    const provider = new MemoryCommerceProvider();
    const deps = testDeps(app.db, { provider });
    await handleSyncProduct(deps, fakeJob(JOBS.syncProduct, { ...store, productId: SHIRT }));
    const row = await withTenant(app.db, store.tenantId, (tx) => getCatalogProduct(tx, store.storeId, SHIRT));
    expect(row?.status).toBe("active");
    expect(deps.jobs.sent.map((s) => s.name)).toContain(JOBS.enrichProduct);

    await handleSyncReconcile(deps, fakeJob(JOBS.syncReconcile, { ...store, full: true }));
    const state = await withTenant(app.db, store.tenantId, (tx) => getSyncState(tx, store.storeId));
    expect(state?.status).toBe("ready");
    expect(state?.lastFullSyncAt).toBeInstanceOf(Date);
  });

  it("enrich.product and embed.product use the models in the store's search config", async () => {
    const store = await newStore(app.db);
    const enricherFor = vi.fn(() => createDemoEnricher());
    const embedderFor = vi.fn(() => createDemoEmbedder());
    const config = parseStoreSearchConfig({
      search: { ...DEMO_SEARCH, enrichmentModel: "demo:enrich-spec", embeddingModel: "demo:embed-spec" },
    });
    const deps = testDeps(app.db, {
      provider: new MemoryCommerceProvider(),
      enricherFor,
      embedderFor,
      storeSearchConfig: async () => config,
    });
    await handleSyncProduct(deps, fakeJob(JOBS.syncProduct, { ...store, productId: SHIRT }));
    await handleEnrichProduct(deps, fakeJob(JOBS.enrichProduct, { ...store, productId: SHIRT }));
    await handleEmbedProduct(deps, fakeJob(JOBS.embedProduct, { ...store, productId: SHIRT }));

    expect(enricherFor).toHaveBeenCalledWith("demo:enrich-spec");
    expect(embedderFor).toHaveBeenCalledWith("demo:embed-spec");
    const row = await withTenant(app.db, store.tenantId, (tx) => getCatalogProduct(tx, store.storeId, SHIRT));
    expect(row?.enrichmentModel).toBe("demo:rules-v1");
    expect(row?.embeddingModel).toBe("demo:hash-v1");
  });
  it("skips sync, enrich and embed jobs of a live-mode store without touching the store or a model", async () => {
    const store = await newStore(app.db, { mode: "live" });
    const providerFor = vi.fn(async () => new MemoryCommerceProvider());
    const enricherFor = vi.fn(() => createDemoEnricher());
    const embedderFor = vi.fn(() => createDemoEmbedder());
    const { logger, lines } = capturingLogger();
    const deps = testDeps(app.db, {
      providerFor,
      enricherFor,
      embedderFor,
      logger,
      storeSearchConfig: async () => parseStoreSearchConfig({ search: { mode: "live" } }),
    });
    const job = { ...store, productId: SHIRT };
    await handleSyncProduct(deps, fakeJob(JOBS.syncProduct, job));
    await handleEnrichProduct(deps, fakeJob(JOBS.enrichProduct, job));
    await handleEmbedProduct(deps, fakeJob(JOBS.embedProduct, job));

    expect(providerFor).not.toHaveBeenCalled();
    expect(enricherFor).not.toHaveBeenCalled();
    expect(embedderFor).not.toHaveBeenCalled();
    expect(deps.jobs.sent).toEqual([]);
    expect(
      await withTenant(app.db, store.tenantId, (tx) => getCatalogProduct(tx, store.storeId, SHIRT)),
    ).toBeNull();
    const skipped = lines.filter((line) => line.msg === "job skipped: store not in index mode");
    expect(skipped.map((line) => line.job)).toEqual([
      JOBS.syncProduct,
      JOBS.enrichProduct,
      JOBS.embedProduct,
    ]);
    expect(skipped[0]).toMatchObject({ storeId: store.storeId });
  });
});
