import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, withTenant } from "./client";
import { listSyncTargets, listTenantIds, resolveWebhookStore } from "./repos/routing";
import * as s from "./schema";
import { createTestDatabase, type TestDatabase } from "./testing";

const testDb = await createTestDatabase();

async function seed(
  db: ReturnType<typeof createDb>["db"],
  name: string,
  opts: { mode?: string; status?: string; secret?: Buffer },
) {
  const tenantId = randomUUID();
  const storeId = await withTenant(db, tenantId, async (tx) => {
    await tx.insert(s.tenants).values({ id: tenantId, name, status: opts.status ?? "active" });
    const [store] = await tx
      .insert(s.stores)
      .values({
        tenantId,
        platform: "memory",
        currency: "LKR",
        config: opts.mode ? { search: { mode: opts.mode } } : {},
        webhookSecretSealed: opts.secret ?? null,
      })
      .returning();
    if (!store) throw new Error("store not created");
    return store.id;
  });
  return { tenantId, storeId };
}

describe.skipIf(testDb === null)("routing functions and vectors (as ace_app)", () => {
  let database: TestDatabase;
  let app: ReturnType<typeof createDb>;
  let indexed: { tenantId: string; storeId: string };
  let live: { tenantId: string; storeId: string };
  let suspended: { tenantId: string; storeId: string };
  const secret = Buffer.from("sealed-secret");

  beforeAll(async () => {
    if (!testDb) return;
    database = testDb;
    app = createDb(database.appUrl, { max: 2 });
    indexed = await seed(app.db, "Indexed", { mode: "index", secret });
    live = await seed(app.db, "Live", { mode: "live" });
    suspended = await seed(app.db, "Suspended", { mode: "index", status: "suspended" });
  });

  afterAll(async () => {
    await app?.close();
    await database?.drop();
  });

  it("hides stores without a tenant, so the functions are the only way in", async () => {
    expect((await app.db.execute(sql`select * from stores`)).rows).toHaveLength(0);
  });

  it("resolves a webhook store to its tenant and sealed secret", async () => {
    const found = await resolveWebhookStore(app.db, indexed.storeId);
    expect(found?.tenantId).toBe(indexed.tenantId);
    expect(found?.webhookSecretSealed?.equals(secret)).toBe(true);
    const noSecret = await resolveWebhookStore(app.db, live.storeId);
    expect(noSecret).toEqual({ tenantId: live.tenantId, webhookSecretSealed: null });
  });

  it("returns null for an unknown store", async () => {
    expect(await resolveWebhookStore(app.db, randomUUID())).toBeNull();
  });

  it("lists only index-mode stores of active tenants as sync targets", async () => {
    const targets = await listSyncTargets(app.db);
    expect(targets).toContainEqual({ tenantId: indexed.tenantId, storeId: indexed.storeId });
    expect(targets.map((t) => t.storeId)).not.toContain(live.storeId);
    expect(targets.map((t) => t.storeId)).not.toContain(suspended.storeId);
  });

  it("lists every tenant", async () => {
    const ids = await listTenantIds(app.db);
    expect(ids).toEqual(expect.arrayContaining([indexed.tenantId, live.tenantId, suspended.tenantId]));
  });

  describe("embeddings", () => {
    const base = (productId: string) => ({
      tenantId: indexed.tenantId,
      storeId: indexed.storeId,
      productId,
      handle: productId,
      title: "Tee",
      description: "A tee",
      currency: "LKR",
      minPrice: 1,
      maxPrice: 1,
      availability: "in_stock",
      searchPrimary: "tee",
      searchSecondary: "",
      contentHash: "h",
    });

    it("round-trips a 768-dimension embedding", async () => {
      const embedding = Array.from({ length: 768 }, (_, i) => (i % 10) / 10);
      const row = await withTenant(app.db, indexed.tenantId, async (tx) => {
        await tx.insert(s.catalogProducts).values({ ...base("vec1"), embedding });
        const [r] = await tx.select().from(s.catalogProducts);
        return r;
      });
      expect(row?.embedding).toEqual(embedding);
    });

    it("rejects an embedding with the wrong dimension", async () => {
      await expect(
        withTenant(app.db, indexed.tenantId, (tx) =>
          tx.insert(s.catalogProducts).values({ ...base("vec2"), embedding: Array(767).fill(0.1) }),
        ),
      ).rejects.toThrow();
    });
  });
});
