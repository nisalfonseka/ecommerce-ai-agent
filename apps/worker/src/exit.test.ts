import { MemoryCommerceProvider } from "@ace/adapter-memory";
import { createDb, getCatalogProduct, getCatalogVariants, withTenant } from "@ace/db";
import { JOBS } from "@ace/db/jobs";
import { createTestDatabase } from "@ace/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleSyncReconcile } from "./handlers/sync";
import { fakeJob, newStore, testDeps } from "./testing";

const testDb = await createTestDatabase();
const PRODUCT = "p_linen_shirt_black";
const VARIANT = "p_linen_shirt_black_m";

describe.skipIf(testDb === null)("Phase 6 dropped-webhook exit", () => {
  let app: ReturnType<typeof createDb>;

  beforeAll(() => {
    if (testDb) app = createDb(testDb.appUrl);
  });
  afterAll(async () => {
    await app?.close();
    await testDb?.drop();
  });

  it("incremental reconciliation repairs a missed price event and full reconciliation marks deletion", async () => {
    const store = await newStore(app.db);
    const provider = new MemoryCommerceProvider({ now: () => new Date("2026-10-12T12:00:00.000Z") });
    const deps = testDeps(app.db, { provider });
    const reconcile = (full: boolean) =>
      handleSyncReconcile(deps, fakeJob(JOBS.syncReconcile, { ...store, full }));

    await reconcile(true);
    provider.setPrice(VARIANT, 999_900);
    // Deliberately send no sync.product job: the scheduled incremental reconcile must repair the dropped event.
    await reconcile(false);
    const variants = await withTenant(app.db, store.tenantId, (tx) =>
      getCatalogVariants(tx, store.storeId, PRODUCT),
    );
    expect(variants.find((variant) => variant.variantId === VARIANT)?.price).toBe(999_900);

    provider.removeProduct(PRODUCT);
    await reconcile(true);
    const product = await withTenant(app.db, store.tenantId, (tx) =>
      getCatalogProduct(tx, store.storeId, PRODUCT),
    );
    expect(product?.status).toBe("deleted");
  });
});
