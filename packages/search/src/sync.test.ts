import { MemoryCommerceProvider } from "@ace/adapter-memory";
import { CommerceError, type ListProductsInput } from "@ace/contracts";
import {
  countCatalog,
  createDb,
  createStore,
  createTenant,
  getCatalogProduct,
  getCatalogVariants,
  getSyncState,
  schema,
  upsertCatalogProduct,
  withTenant,
} from "@ace/db";
import type { JobName, JobPayload, JobQueue } from "@ace/db/jobs";
import { createTestDatabase, type TestDatabase } from "@ace/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { productRows } from "./rows";
import { reconcileStore, type SyncDeps, syncProduct } from "./sync";

const testDb = await createTestDatabase();
const MODEL = "demo:embed";
const SHIRT = "p_linen_shirt_black";

class RecordingQueue implements JobQueue {
  sent: { name: JobName; data: unknown }[] = [];
  async send<N extends JobName>(name: N, data: JobPayload<N>): Promise<void> {
    this.sent.push({ name, data });
  }
  names(): JobName[] {
    return this.sent.map((s) => s.name);
  }
}

describe.skipIf(testDb === null)("read model sync", () => {
  let database: TestDatabase;
  let app: ReturnType<typeof createDb>;

  async function newStore(): Promise<{ tenantId: string; storeId: string }> {
    const { tenantId } = await createTenant(app.db, { name: `Search ${crypto.randomUUID()}` });
    const storeId = await withTenant(app.db, tenantId, async (tx) => {
      return (await createStore(tx, tenantId, { platform: "memory", currency: "LKR" })).id;
    });
    return { tenantId, storeId };
  }

  async function setup(provider = new MemoryCommerceProvider()) {
    const ids = await newStore();
    const jobs = new RecordingQueue();
    const deps: SyncDeps = { db: app.db, ...ids, provider, jobs, embeddingModel: MODEL };
    return { ...ids, provider, jobs, deps };
  }

  beforeAll(async () => {
    if (!testDb) return;
    database = testDb;
    app = createDb(database.appUrl);
  });

  afterAll(async () => {
    await app?.close();
    await database?.drop();
  });

  describe("syncProduct", () => {
    it("creates, then reports unchanged with no job", async () => {
      const { deps, jobs, tenantId, storeId } = await setup();
      expect(await syncProduct(deps, SHIRT)).toBe("created");
      expect(jobs.sent).toEqual([{ name: "enrich.product", data: { tenantId, storeId, productId: SHIRT } }]);
      const rows = await withTenant(app.db, tenantId, async (tx) => ({
        product: await getCatalogProduct(tx, storeId, SHIRT),
        variants: await getCatalogVariants(tx, storeId, SHIRT),
      }));
      expect(rows.product?.status).toBe("active");
      expect(rows.variants).toHaveLength(3);
      jobs.sent = [];
      expect(await syncProduct(deps, SHIRT)).toBe("unchanged");
      expect(jobs.sent).toEqual([]);
    });

    it("a stock change updates the variant without an enrich job", async () => {
      const { deps, jobs, provider, tenantId, storeId } = await setup();
      await syncProduct(deps, SHIRT);
      jobs.sent = [];
      const live = await provider.getProduct(SHIRT);
      const variant = live?.variants.find((v) => v.availability === "in_stock");
      if (!variant) throw new Error("seed");
      provider.setStock(variant.id, 0);
      expect(await syncProduct(deps, SHIRT)).toBe("updated");
      expect(jobs.sent).toEqual([]);
      const variants = await withTenant(app.db, tenantId, (tx) => getCatalogVariants(tx, storeId, SHIRT));
      expect(variants.find((v) => v.variantId === variant.id)?.availability).toBe("out_of_stock");
    });

    it("a description change enqueues enrichment", async () => {
      const { deps, jobs, provider } = await setup();
      await syncProduct(deps, SHIRT);
      jobs.sent = [];
      // The memory provider has no description control; patch the seed through the live reference it clones.
      const seed = (provider as unknown as { seed: { products: { id: string; description: string }[] } })
        .seed;
      const product = seed.products.find((p) => p.id === SHIRT);
      if (!product) throw new Error("seed");
      product.description = `${product.description} Now with a hem.`;
      expect(await syncProduct(deps, SHIRT)).toBe("updated");
      expect(jobs.names()).toEqual(["enrich.product"]);
    });

    it("marks a product the store dropped as deleted but keeps its variants", async () => {
      const { deps, provider, tenantId, storeId } = await setup();
      await syncProduct(deps, SHIRT);
      provider.removeProduct(SHIRT);
      expect(await syncProduct(deps, SHIRT)).toBe("deleted");
      const rows = await withTenant(app.db, tenantId, async (tx) => ({
        product: await getCatalogProduct(tx, storeId, SHIRT),
        variants: await getCatalogVariants(tx, storeId, SHIRT),
        counts: await countCatalog(tx, storeId),
      }));
      expect(rows.product?.status).toBe("deleted");
      expect(rows.variants).toHaveLength(3);
      expect(rows.counts).toMatchObject({ active: 0, deleted: 1 });
    });

    it("reports missing for an unknown id with no row", async () => {
      const { deps } = await setup();
      expect(await syncProduct(deps, "nope")).toBe("missing");
    });

    it("keeps enriched and overrides across a re-sync and re-embeds only when stale", async () => {
      const { deps, jobs, provider, tenantId, storeId } = await setup();
      await syncProduct(deps, SHIRT);
      const enriched = { occasion: ["Work"] };
      const overrides = { color: ["navy"] };
      await withTenant(app.db, tenantId, (tx) =>
        tx
          .update(schema.catalogProducts)
          .set({ enriched, overrides })
          .where(eq(schema.catalogProducts.storeId, storeId)),
      );
      jobs.sent = [];
      // The effective attributes now include the enrichment (the row was edited directly, so it differs),
      // and the row was never embedded: embed.product, not enrich.
      expect(await syncProduct(deps, SHIRT)).toBe("updated");
      expect(jobs.names()).toEqual(["embed.product"]);
      const variant = (await provider.getProduct(SHIRT))?.variants[0];
      if (!variant) throw new Error("seed");
      provider.setPrice(variant.id, 1_234_500);
      expect(await syncProduct(deps, SHIRT)).toBe("updated");
      const row = await withTenant(app.db, tenantId, (tx) => getCatalogProduct(tx, storeId, SHIRT));
      expect(row?.enriched).toEqual(enriched);
      expect(row?.overrides).toEqual(overrides);
      expect(row?.attributes).toMatchObject({ color: ["navy"] });
      expect(row?.attributes).toHaveProperty("occasion", expect.arrayContaining(["work"]));
      expect(row?.maxPrice).toBe(1_234_500);
    });

    it("never touches another tenant's rows for identical product ids", async () => {
      const a = await setup();
      const b = await setup();
      await syncProduct(a.deps, SHIRT);
      await syncProduct(b.deps, SHIRT);
      a.provider.removeProduct(SHIRT);
      await syncProduct(a.deps, SHIRT);
      const bRow = await withTenant(app.db, b.tenantId, (tx) => getCatalogProduct(tx, b.storeId, SHIRT));
      expect(bRow?.status).toBe("active");
      const aSeesB = await withTenant(app.db, a.tenantId, (tx) => getCatalogProduct(tx, b.storeId, SHIRT));
      expect(aSeesB).toBeNull();
    });
  });

  describe("reconcileStore", () => {
    it("full sync of the seed: every product active, ready, watermark = max updatedAt", async () => {
      const { deps, provider, tenantId, storeId } = await setup();
      const result = await reconcileStore(deps, { full: true });
      const all = (await provider.listProducts({ limit: 250 })).items;
      expect(result).toEqual({ seen: all.length, changed: all.length, deleted: 0 });
      const max = Math.max(...all.map((p) => Date.parse(p.updatedAt)));
      const { state, counts } = await withTenant(app.db, tenantId, async (tx) => ({
        state: await getSyncState(tx, storeId),
        counts: await countCatalog(tx, storeId),
      }));
      expect(counts.active).toBe(all.length);
      expect(state?.status).toBe("ready");
      expect(state?.watermark?.getTime()).toBe(max);
      expect(state?.lastFullSyncAt).not.toBeNull();
      expect(state?.lastError).toBeNull();
    });

    it("a full sync marks products the store removed as deleted", async () => {
      const { deps, provider, tenantId, storeId } = await setup();
      await reconcileStore(deps, { full: true });
      const total = (await provider.listProducts({ limit: 250 })).items.length;
      provider.removeProduct(SHIRT);
      expect(await reconcileStore(deps, { full: true })).toMatchObject({ seen: total - 1, deleted: 1 });
      const counts = await withTenant(app.db, tenantId, (tx) => countCatalog(tx, storeId));
      expect(counts).toMatchObject({ active: total - 1, deleted: 1 });
    });

    it("incremental asks only for products since watermark minus 5 minutes", async () => {
      const { deps, provider, tenantId, storeId } = await setup();
      await reconcileStore(deps, { full: true });
      const state = await withTenant(app.db, tenantId, (tx) => getSyncState(tx, storeId));
      const inputs: ListProductsInput[] = [];
      const original = provider.listProducts.bind(provider);
      provider.listProducts = async (input) => {
        inputs.push(input);
        return original(input);
      };
      const result = await reconcileStore(deps, { full: false });
      expect(inputs[0]?.updatedSince).toBe(
        new Date((state?.watermark?.getTime() ?? 0) - 300_000).toISOString(),
      );
      expect(result.deleted).toBe(0);
      expect(result.changed).toBe(0);
    });

    it("records the error code, keeps earlier pages and stays 'error' without a prior full sync", async () => {
      const { deps, provider, tenantId, storeId } = await setup();
      const original = provider.listProducts.bind(provider);
      let calls = 0;
      provider.listProducts = async (input) => {
        calls += 1;
        if (calls === 2) throw new CommerceError("UPSTREAM_UNAVAILABLE", "down");
        const page = await original({ ...input, limit: 4 });
        return page;
      };
      await expect(reconcileStore(deps, { full: true })).rejects.toThrow("down");
      const { state, counts } = await withTenant(app.db, tenantId, async (tx) => ({
        state: await getSyncState(tx, storeId),
        counts: await countCatalog(tx, storeId),
      }));
      expect(state?.status).toBe("error");
      expect(state?.lastError).toBe("UPSTREAM_UNAVAILABLE");
      expect(counts.active).toBe(4);
    });

    it("a failed full sync stays ready when an earlier full sync succeeded", async () => {
      const { deps, provider, tenantId, storeId } = await setup();
      await reconcileStore(deps, { full: true });
      provider.listProducts = async () => {
        throw new CommerceError("UPSTREAM_UNAVAILABLE", "down");
      };
      await expect(reconcileStore(deps, { full: true })).rejects.toThrow();
      const state = await withTenant(app.db, tenantId, (tx) => getSyncState(tx, storeId));
      expect(state).toMatchObject({ status: "ready", lastError: "UPSTREAM_UNAVAILABLE" });
    });
  });
  describe("backfill and stale writes", () => {
    it("full reconcile re-sends a lost enrich job; incremental and repeat syncProduct do not", async () => {
      const { deps, jobs, tenantId, storeId } = await setup();
      await reconcileStore(deps, { full: true });
      jobs.sent = []; // simulate the sends lost after the rows committed
      expect(await syncProduct(deps, SHIRT)).toBe("unchanged");
      await reconcileStore(deps, { full: false });
      expect(jobs.sent).toEqual([]);
      await reconcileStore(deps, { full: true });
      expect(jobs.sent.filter((j) => (j.data as { productId: string }).productId === SHIRT)).toEqual([
        { name: "enrich.product", data: { tenantId, storeId, productId: SHIRT } },
      ]);
      expect(jobs.names().every((n) => n === "enrich.product")).toBe(true);
    });

    it("full reconcile sends embed.product for an enriched row embedded with another model", async () => {
      const { deps, jobs, tenantId, storeId } = await setup();
      await reconcileStore(deps, { full: true });
      await withTenant(app.db, tenantId, (tx) =>
        tx
          .update(schema.catalogProducts)
          .set({ enriched: {}, embeddedHash: "old", embeddingModel: "demo:other" })
          .where(eq(schema.catalogProducts.storeId, storeId)),
      );
      jobs.sent = [];
      await reconcileStore(deps, { full: false });
      const incrementalNames = jobs.names();
      jobs.sent = [];
      await reconcileStore(deps, { full: true });
      expect(jobs.names().every((n) => n === "embed.product")).toBe(true);
      expect(jobs.sent.length).toBeGreaterThan(0);
      expect(incrementalNames.every((n) => n === "embed.product")).toBe(true);
    });

    it("ignores an older version written after a newer one", async () => {
      const newer = await setup(
        new MemoryCommerceProvider({ now: () => new Date("2026-10-08T00:00:00.000Z") }),
      );
      const { tenantId, storeId, provider, deps, jobs } = newer;
      const variant = (await provider.getProduct(SHIRT))?.variants[0];
      if (!variant) throw new Error("seed");
      provider.setPrice(variant.id, 777_700);
      await syncProduct(deps, SHIRT);
      jobs.sent = [];

      const older = new MemoryCommerceProvider({ now: () => new Date("2026-10-02T00:00:00.000Z") });
      older.setPrice(variant.id, 111_100);
      expect(await syncProduct({ ...deps, provider: older }, SHIRT)).toBe("unchanged");
      expect(jobs.sent).toEqual([]);

      // The repo guard also holds when the read-side check is bypassed (concurrent writer).
      const stale = await older.getProduct(SHIRT);
      if (!stale) throw new Error("seed");
      const applied = await withTenant(app.db, tenantId, (tx) =>
        upsertCatalogProduct(tx, tenantId, productRows(storeId, stale)),
      );
      expect(applied).toBe(false);
      const { row, variants } = await withTenant(app.db, tenantId, async (tx) => ({
        row: await getCatalogProduct(tx, storeId, SHIRT),
        variants: await getCatalogVariants(tx, storeId, SHIRT),
      }));
      expect(row?.maxPrice).toBe(777_700);
      expect(variants.find((v) => v.variantId === variant.id)?.price).toBe(777_700);
    });
  });
});
