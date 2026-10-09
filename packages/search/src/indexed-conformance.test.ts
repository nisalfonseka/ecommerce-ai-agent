import { MemoryCommerceProvider, memoryFixtures } from "@ace/adapter-memory";
import { describeProviderConformance } from "@ace/contracts/testing";
import { createDb } from "@ace/db";
import { createTestDatabase } from "@ace/db/testing";
import type { Embedder } from "@ace/knowledge";
import { afterAll, beforeAll, describe } from "vitest";
import { IndexedCatalogProvider } from "./indexed-provider";
import { indexedStore } from "./test-fixture";

const testDb = await createTestDatabase();

describe.skipIf(testDb === null)("IndexedCatalogProvider over the memory store", () => {
  let app: ReturnType<typeof createDb>;
  let store: { tenantId: string; storeId: string; embedder: Embedder };

  // One indexed store (sync state ready); each test gets a fresh live provider with the same catalog.
  beforeAll(async () => {
    if (!testDb) return;
    app = createDb(testDb.appUrl);
    store = await indexedStore(app.db);
  });
  afterAll(async () => {
    await app?.close();
    await testDb?.drop();
  });

  describeProviderConformance("indexed(memory)", async () => {
    const inner = new MemoryCommerceProvider();
    const provider = new IndexedCatalogProvider(inner, { db: app.db, ...store });
    return {
      provider,
      fixtures: { ...memoryFixtures, control: { setStock: async (id, qty) => inner.setStock(id, qty) } },
    };
  });
});
