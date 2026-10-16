import { createDb, getTenantSettings, listDocuments, resolveWidgetKey, schema, withTenant } from "@ace/db";
import { createTestDatabase } from "@ace/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { authenticateStaff } from "./auth/staff";
import { seedDemoTenants, seedTenantId } from "./seed";

const testDb = await createTestDatabase();

describe.skipIf(testDb === null)("seedDemoTenants", () => {
  const pool = testDb ? createDb(testDb.appUrl) : null;
  afterAll(async () => {
    await pool?.close();
    await testDb?.drop();
  });

  it("creates two isolated demo tenants with working widget keys, and is safe to re-run", async () => {
    if (!pool) return;
    const options = { model: "demo:search-only", origins: ["http://localhost:5173"] };
    const first = await seedDemoTenants(pool.db, options);
    expect(first.map((t) => t.name)).toEqual(["Demo Clothing A", "Demo Clothing B"]);
    expect(first[0]?.tenantId).toBe(seedTenantId("Demo Clothing A"));
    for (const tenant of first) {
      expect(await resolveWidgetKey(pool.db, tenant.key)).toMatchObject({
        tenantId: tenant.tenantId,
        botId: tenant.botId,
        allowedOrigins: ["http://localhost:5173"],
      });
      const seeded = await withTenant(pool.db, tenant.tenantId, async (tx) => ({
        store: (await tx.select().from(schema.stores).where(eq(schema.stores.id, tenant.storeId)))[0],
        documents: await listDocuments(tx, tenant.storeId),
        settings: await getTenantSettings(tx),
      }));
      expect(seeded.store?.config).toMatchObject({
        search: {
          mode: "index",
          embeddingModel: "demo:hash-v1",
          enrichmentModel: "demo:rules-v1",
        },
      });
      expect(seeded.documents).toHaveLength(2);
      expect(seeded.documents.every((document) => document.status === "ready")).toBe(true);
      expect(seeded.settings).toMatchObject({
        handoffEmails: ["support@example.test"],
        requireConsent: true,
        retention: { messagesDays: 180, tracesDays: 30, handoffDays: 180, otpHours: 24 },
      });
      const staffToken = tenant.staffToken;
      expect(staffToken).toMatch(new RegExp(`^st_${tenant.tenantId}\\.`));
      expect(await authenticateStaff(pool.db, `Bearer ${staffToken}`)).toMatchObject({
        tenantId: tenant.tenantId,
        name: "Local Support",
      });
    }
    const second = await seedDemoTenants(pool.db, options);
    expect(second.map((t) => [t.tenantId, t.botId])).toEqual(first.map((t) => [t.tenantId, t.botId]));
    expect(second.map((t) => t.storeId)).toEqual(first.map((t) => t.storeId));
    expect(second[0]?.key).not.toBe(first[0]?.key);
    for (const tenant of first)
      expect(await authenticateStaff(pool.db, `Bearer ${tenant.staffToken}`)).toBeNull();
    for (const tenant of second) {
      expect(await authenticateStaff(pool.db, `Bearer ${tenant.staffToken}`)).toMatchObject({
        tenantId: tenant.tenantId,
        name: "Local Support",
      });
    }
  });
});

describe("seedTenantId", () => {
  it("is a stable UUID per name", () => {
    expect(seedTenantId("Demo Clothing A")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(seedTenantId("Demo Clothing A")).toBe(seedTenantId("Demo Clothing A"));
    expect(seedTenantId("Demo Clothing A")).not.toBe(seedTenantId("Demo Clothing B"));
  });
});
