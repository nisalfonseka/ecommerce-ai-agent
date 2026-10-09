import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, type Db, withTenant } from "./client";
import * as s from "./schema";
import { TENANT_TABLES } from "./schema";
import { createTestDatabase, type TestDatabase } from "./testing";

const testDb = await createTestDatabase();

async function seedTenant(db: Db, name: string): Promise<{ tenantId: string; keyHash: string }> {
  const tenantId = randomUUID();
  const keyHash = createHash("sha256").update(`pk_test_${name}`).digest("hex");
  await withTenant(db, tenantId, async (tx) => {
    await tx.insert(s.tenants).values({ id: tenantId, name });
    const [store] = await tx
      .insert(s.stores)
      .values({ tenantId, platform: "memory", currency: "LKR" })
      .returning();
    if (!store) throw new Error("store not created");
    const [bot] = await tx
      .insert(s.bots)
      .values({
        tenantId,
        storeId: store.id,
        persona: {},
        storeFacts: {},
        model: "google:gemini-flash-latest",
        cheapModel: "google:gemini-flash-lite-latest",
        budgetSoftUsdMicros: 1_000_000,
        budgetHardUsdMicros: 2_000_000,
      })
      .returning();
    if (!bot) throw new Error("bot not created");
    await tx.insert(s.widgetKeys).values({
      tenantId,
      botId: bot.id,
      keyHash,
      keyPrefix: "pk_test",
      allowedOrigins: ["https://shop.test"],
    });
    const [conversation] = await tx
      .insert(s.conversations)
      .values({ tenantId, botId: bot.id, visitorId: "v1", session: {} })
      .returning();
    if (!conversation) throw new Error("conversation not created");
    const conversationId = conversation.id;
    await tx.insert(s.messages).values({ tenantId, conversationId, seq: 0, kind: "model", payload: {} });
    await tx
      .insert(s.toolCalls)
      .values({ tenantId, conversationId, turnId: "t1", name: "search_products", ok: true, ms: 5 });
    await tx.insert(s.turnTraces).values({
      tenantId,
      conversationId,
      turnId: "t1",
      model: "m",
      promptVersion: "p",
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
      toolNames: [],
      outcomes: [],
      regenerated: false,
      ungroundedCount: 0,
    });
    await tx
      .insert(s.usageLedger)
      .values({ tenantId, botId: bot.id, turnId: "t1", model: "m", inputTokens: 1, outputTokens: 1 });
    await tx.insert(s.idempotencyRecords).values({
      tenantId,
      storeId: store.id,
      operation: "addCartLines",
      target: "cart_1",
      key: "k1",
      fingerprint: "f",
      status: "completed",
    });
  });
  return { tenantId, keyHash };
}

async function count(db: Db, table: string): Promise<number> {
  const result = await db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`));
  return result.rows[0]?.n ?? -1;
}

describe.skipIf(testDb === null)("row-level security (as ace_app)", () => {
  let database: TestDatabase;
  let app: ReturnType<typeof createDb>;
  let a: { tenantId: string; keyHash: string };
  let b: { tenantId: string; keyHash: string };

  beforeAll(async () => {
    if (!testDb) return;
    database = testDb;
    app = createDb(database.appUrl, { max: 1 });
    a = await seedTenant(app.db, "Tenant A");
    b = await seedTenant(app.db, "Tenant B");
  });

  afterAll(async () => {
    await app?.close();
    await database?.drop();
  });

  it("shows each tenant only its own rows in every tenant table", async () => {
    for (const { tenantId } of [a, b]) {
      await withTenant(app.db, tenantId, async (tx) => {
        const tenants = await tx.select().from(s.tenants);
        expect(tenants.map((t) => t.id)).toEqual([tenantId]);
        for (const table of TENANT_TABLES) {
          const rows = await tx.execute<{ tenant_id: string }>(sql.raw(`select tenant_id from ${table}`));
          expect(
            rows.rows.map((row) => row.tenant_id),
            table,
          ).toEqual([tenantId]);
        }
      });
    }
  });

  it("rejects writes that carry another tenant's id", async () => {
    await expect(
      withTenant(app.db, a.tenantId, (tx) =>
        tx.insert(s.stores).values({ tenantId: b.tenantId, platform: "memory", currency: "LKR" }),
      ),
    ).rejects.toThrow();
  });

  it("returns nothing and refuses writes outside withTenant", async () => {
    expect(await count(app.db, "tenants")).toBe(0);
    for (const table of TENANT_TABLES) expect(await count(app.db, table), table).toBe(0);
    await expect(
      app.db.insert(s.stores).values({ tenantId: a.tenantId, platform: "memory", currency: "LKR" }),
    ).rejects.toThrow();
  });

  it("does not leak the tenant to the next use of a pooled connection", async () => {
    // max: 1, so this runs on the same connection the previous withTenant used.
    await withTenant(app.db, a.tenantId, async () => undefined);
    expect(await count(app.db, "stores")).toBe(0);
  });

  it("hides the widget-key lookup table but resolves keys through the definer function", async () => {
    await expect(app.db.execute(sql`select * from widget_key_lookup`)).rejects.toMatchObject({
      cause: { message: expect.stringMatching(/permission denied/) },
    });
    const found = await app.db.execute<{ tenant_id: string; allowed_origins: string[] }>(
      sql`select * from resolve_widget_key(${a.keyHash})`,
    );
    expect(found.rows).toEqual([
      expect.objectContaining({ tenant_id: a.tenantId, allowed_origins: ["https://shop.test"] }),
    ]);
    expect((await app.db.execute(sql`select * from resolve_widget_key(${"nope"})`)).rows).toEqual([]);
  });

  it("stops resolving a key once it is revoked", async () => {
    await withTenant(app.db, b.tenantId, (tx) =>
      tx.update(s.widgetKeys).set({ revokedAt: new Date() }).where(sql`key_hash = ${b.keyHash}`),
    );
    expect((await app.db.execute(sql`select * from resolve_widget_key(${b.keyHash})`)).rows).toEqual([]);
  });

  it("refuses a tenant id that is not a UUID before querying", async () => {
    await expect(withTenant(app.db, "tenant-a", async () => 1)).rejects.toThrow(/UUID/);
  });

  it("rolls back when the callback throws and returns its value otherwise", async () => {
    await expect(
      withTenant(app.db, a.tenantId, async (tx) => {
        await tx.insert(s.stores).values({ tenantId: a.tenantId, platform: "memory", currency: "USD" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const currencies = await withTenant(app.db, a.tenantId, async (tx) =>
      (await tx.select().from(s.stores)).map((store) => store.currency),
    );
    expect(currencies).toEqual(["LKR"]);
  });
});
