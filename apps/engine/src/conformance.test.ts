import { MemoryCommerceProvider, memoryFixtures } from "@ace/adapter-memory";
import { describeProviderConformance } from "@ace/contracts/testing";
import { createDb, createPgIdempotencyStore, createTenant } from "@ace/db";
import { createTestDatabase } from "@ace/db/testing";
import { afterAll, describe, it } from "vitest";
import { IdempotentCommerceProvider } from "./idempotent-provider";

// ADR-002: the conformance suite (including replay) must pass against the engine's idempotency layer.
const testDb = await createTestDatabase();

if (testDb) {
  const app = createDb(testDb.appUrl);
  const { tenantId } = await createTenant(app.db, { name: "Conformance" });
  afterAll(async () => {
    await app.close();
    await testDb.drop();
  });
  describeProviderConformance("memory + IdempotentCommerceProvider (Postgres)", async () => ({
    provider: new IdempotentCommerceProvider(
      new MemoryCommerceProvider(),
      createPgIdempotencyStore(app.db, tenantId),
      { storeId: "00000000-0000-4000-8000-000000000001" },
    ),
    fixtures: memoryFixtures,
  }));
} else {
  describe.skip("conformance over Postgres idempotency (needs ACE_TEST_DATABASE_URL)", () => {
    it("skipped", () => {});
  });
}
