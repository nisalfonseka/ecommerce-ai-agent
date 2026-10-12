import { MemoryCommerceProvider } from "@ace/adapter-memory";
import { createDb, getCatalogProduct, schema, withTenant } from "@ace/db";
import { createTestDatabase, type TestDatabase } from "@ace/db/testing";
import { createDemoEmbedder, type Embedder } from "@ace/knowledge";
import { and, eq, isNotNull } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { embedStoredProduct } from "./embed-product";
import { embeddingHash, embeddingText } from "./rows";
import { reconcileStore } from "./sync";
import { NullQueue, newTenantStore } from "./test-fixture";

const testDb = await createTestDatabase();
const SHIRT = "p_linen_shirt_black";

class CountingEmbedder implements Embedder {
  calls: { values: string[]; purpose: string }[] = [];
  private readonly demo = createDemoEmbedder();
  constructor(readonly model: string) {}
  async embed(values: string[], purpose: "document" | "query"): Promise<number[][]> {
    this.calls.push({ values, purpose });
    return this.demo.embed(values, purpose);
  }
}

describe.skipIf(testDb === null)("embedStoredProduct", () => {
  let database: TestDatabase;
  let app: ReturnType<typeof createDb>;

  beforeAll(async () => {
    if (!testDb) return;
    database = testDb;
    app = createDb(database.appUrl);
  });
  afterAll(async () => {
    await app?.close();
    await database?.drop();
  });

  async function syncedStore() {
    const ids = await newTenantStore(app.db);
    await reconcileStore(
      {
        db: app.db,
        ...ids,
        provider: new MemoryCommerceProvider(),
        jobs: new NullQueue(),
        embeddingModel: "demo:hash-v1",
      },
      { full: true },
    );
    return ids;
  }

  const stored = (tenantId: string, storeId: string) =>
    withTenant(app.db, tenantId, async (tx) => {
      const p = schema.catalogProducts;
      const [row] = await tx
        .select({ model: p.embeddingModel, hash: p.embeddedHash })
        .from(p)
        .where(and(eq(p.storeId, storeId), eq(p.productId, SHIRT), isNotNull(p.embedding)));
      return { row, product: await getCatalogProduct(tx, storeId, SHIRT) };
    });

  it("stores the vector, hash and model; skips when both match; re-embeds for another model", async () => {
    const { tenantId, storeId } = await syncedStore();
    const embedder = new CountingEmbedder("demo:hash-v1");
    expect(await embedStoredProduct({ db: app.db, tenantId, storeId, embedder }, SHIRT)).toBe("embedded");
    const { row, product } = await stored(tenantId, storeId);
    if (!product) throw new Error("row");
    const text = embeddingText({
      title: product.title,
      category: product.category,
      attributes: product.attributes as Record<string, string[]>,
      tags: product.tags,
      description: product.description,
    });
    expect(embedder.calls).toEqual([{ values: [text], purpose: "document" }]);
    expect(row).toEqual({ model: "demo:hash-v1", hash: embeddingHash(text) });

    expect(await embedStoredProduct({ db: app.db, tenantId, storeId, embedder }, SHIRT)).toBe("skipped");
    expect(embedder.calls).toHaveLength(1);

    const other = new CountingEmbedder("demo:other-v2");
    expect(await embedStoredProduct({ db: app.db, tenantId, storeId, embedder: other }, SHIRT)).toBe(
      "embedded",
    );
    expect((await stored(tenantId, storeId)).row?.model).toBe("demo:other-v2");
  });

  it("re-embeds when the embedding text changed", async () => {
    const { tenantId, storeId } = await syncedStore();
    const embedder = new CountingEmbedder("demo:hash-v1");
    await embedStoredProduct({ db: app.db, tenantId, storeId, embedder }, SHIRT);
    await withTenant(app.db, tenantId, (tx) =>
      tx
        .update(schema.catalogProducts)
        .set({ attributes: { color: ["navy"] } })
        .where(eq(schema.catalogProducts.storeId, storeId)),
    );
    expect(await embedStoredProduct({ db: app.db, tenantId, storeId, embedder }, SHIRT)).toBe("embedded");
    expect(embedder.calls).toHaveLength(2);
  });

  it("reports missing for unknown and deleted products, embedding nothing", async () => {
    const { tenantId, storeId } = await syncedStore();
    const embedder = new CountingEmbedder("demo:hash-v1");
    expect(await embedStoredProduct({ db: app.db, tenantId, storeId, embedder }, "nope")).toBe("missing");
    await withTenant(app.db, tenantId, (tx) =>
      tx
        .update(schema.catalogProducts)
        .set({ status: "deleted" })
        .where(eq(schema.catalogProducts.storeId, storeId)),
    );
    expect(await embedStoredProduct({ db: app.db, tenantId, storeId, embedder }, SHIRT)).toBe("missing");
    expect(embedder.calls).toEqual([]);
  });

  it("is store-scoped: another store's id is missing", async () => {
    const a = await syncedStore();
    const b = await newTenantStore(app.db, a.tenantId);
    const embedder = new CountingEmbedder("demo:hash-v1");
    expect(
      await embedStoredProduct({ db: app.db, tenantId: a.tenantId, storeId: b.storeId, embedder }, SHIRT),
    ).toBe("missing");
  });
});
