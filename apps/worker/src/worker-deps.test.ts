import { createDb, type Db } from "@ace/db";
import { createTestDatabase } from "@ace/db/testing";
import { createLogNotifier } from "@ace/notify";
import { IdempotentCommerceProvider } from "@ace/providers";
import { afterAll, describe, expect, it } from "vitest";
import { createLogger } from "./log";
import { DEMO_SEARCH, newStore, RecordingQueue } from "./testing";
import { createWorkerDeps } from "./worker-deps";

const testDb = await createTestDatabase();
const wiring = (db: Db, allowDemoModels: boolean) =>
  createWorkerDeps({
    db,
    jobs: new RecordingQueue(),
    logger: createLogger({ level: "silent" }),
    masterKey: Buffer.alloc(32, 4),
    allowDemoModels,
    notifier: createLogNotifier(() => undefined),
    dashboardBaseUrl: "http://localhost:3000",
  });

describe("createWorkerDeps models", () => {
  it("builds demo models only outside production", () => {
    const dev = wiring({} as Db, true);
    expect(dev.enricherFor("demo:rules-v1").model).toBe("demo:rules-v1");
    expect(dev.embedderFor("demo:hash-v1").model).toBe("demo:hash-v1");
    const prod = wiring({} as Db, false);
    expect(() => prod.enricherFor("demo:rules-v1")).toThrow(/production/);
    expect(() => prod.embedderFor("demo:hash-v1")).toThrow(/production/);
  });

  it("builds an LLM enricher named after its spec", () => {
    expect(wiring({} as Db, false).enricherFor("google:gemini-flash-lite-latest").model).toBe(
      "google:gemini-flash-lite-latest",
    );
  });
});

describe.skipIf(testDb === null)("createWorkerDeps stores", () => {
  const app = testDb ? createDb(testDb.appUrl) : null;
  afterAll(async () => {
    await app?.close();
    await testDb?.drop();
  });

  it("serves an index-mode store through the idempotency layer, never the index decorator", async () => {
    if (!app) return;
    const store = await newStore(app.db);
    const deps = wiring(app.db, true);
    const provider = await deps.providerFor(store.tenantId, store.storeId);
    expect(provider).toBeInstanceOf(IdempotentCommerceProvider);
    expect(await deps.storeSearchConfig(store.tenantId, store.storeId)).toMatchObject(DEMO_SEARCH);
  });

  it("refuses a store of another tenant", async () => {
    if (!app) return;
    const a = await newStore(app.db);
    const b = await newStore(app.db);
    await expect(wiring(app.db, true).providerFor(a.tenantId, b.storeId)).rejects.toThrow(/not found/);
  });
});
