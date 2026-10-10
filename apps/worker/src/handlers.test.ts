import { MemoryCommerceProvider } from "@ace/adapter-memory";
import {
  createDb,
  type Db,
  getCatalogVariants,
  markWebhookEnqueued,
  recordWebhookEvent,
  withTenant,
} from "@ace/db";
import { JOBS, openJobQueue } from "@ace/db/jobs";
import { createTestDatabase } from "@ace/db/testing";
import { afterAll, describe, expect, it } from "vitest";
import { loadWorkerConfig } from "./config";
import { HANDLERS, registerHandlers } from "./handlers";
import { createLogger } from "./log";
import { registerSchedules } from "./schedules";
import { capturingLogger, fakeJob, newStore, testDeps } from "./testing";
import { startWorker } from "./worker";

const testDb = await createTestDatabase();
const SHIRT = "p_linen_shirt_black";
const SHIRT_L = "p_linen_shirt_black_l";

describe("worker handlers", () => {
  it("registers every job but knowledge.ingest (Task 10)", async () => {
    const names: string[] = [];
    const boss = {
      work: async (name: string) => {
        names.push(name);
        return name;
      },
    };
    await registerHandlers(boss, testDeps({} as Db), { concurrency: 2 });
    const expected = Object.values(JOBS).filter((name) => name !== JOBS.knowledgeIngest);
    expect(names.sort()).toEqual([...expected].sort());
  });

  it.each(Object.entries(HANDLERS))(
    "%s logs job.invalid_payload with name and id only, and completes",
    async (name, handler) => {
      const { logger, lines } = capturingLogger();
      // Database access would throw on this stub: an invalid payload must stop before it.
      const deps = testDeps({} as Db, { logger });
      // Not an object, so it fails every payload schema (retention.purge accepts any object).
      const job = fakeJob(name, "secret-looking-value");
      await expect(handler(deps, job)).resolves.toBeUndefined();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ msg: "job.invalid_payload", job: name, jobId: job.id });
      expect(JSON.stringify(lines)).not.toContain("secret-looking-value");
    },
  );

  it("schedules incremental and full reconciles under separate keys, and the purge", async () => {
    const calls: { name: string; cron: string; data: unknown; key: string | undefined }[] = [];
    const boss = {
      schedule: async (name: string, cron: string, data?: object | null, options?: { key?: string }) => {
        calls.push({ name, cron, data, key: options?.key });
      },
    };
    await registerSchedules(boss, {
      reconcileCron: "*/15 * * * *",
      fullReconcileCron: "30 2 * * *",
      retentionCron: "0 3 * * *",
    });
    expect(calls).toEqual([
      { name: JOBS.syncReconcileAll, cron: "*/15 * * * *", data: { full: false }, key: "incremental" },
      { name: JOBS.syncReconcileAll, cron: "30 2 * * *", data: { full: true }, key: "full" },
      { name: JOBS.retentionPurge, cron: "0 3 * * *", data: {}, key: undefined },
    ]);
  });
});

describe.skipIf(testDb === null)("worker smoke (real pg-boss)", () => {
  const app = testDb ? createDb(testDb.appUrl) : null;
  afterAll(async () => {
    await app?.close();
    await testDb?.drop();
  });

  it("a signed product webhook's job updates catalog_variants within 10 s", async () => {
    if (!testDb || !app) return;
    const store = await newStore(app.db);
    const provider = new MemoryCommerceProvider();
    const config = loadWorkerConfig({
      DATABASE_URL: testDb.appUrl,
      ACE_MASTER_KEY: Buffer.alloc(32, 9).toString("base64"),
      NODE_ENV: "test",
    });
    const worker = await startWorker({
      config,
      logger: createLogger({ level: "silent" }),
      providerFor: async () => provider,
    });
    const producer = await openJobQueue(testDb.appUrl, "producer");
    try {
      provider.setPrice(SHIRT_L, 777_700);
      // The webhook route's effect (Task 3): record the event, enqueue a debounced sync.product, mark enqueued.
      const eventId = `product.updated:${SHIRT}:1`;
      const recorded = await withTenant(app.db, store.tenantId, (tx) =>
        recordWebhookEvent(tx, store.tenantId, {
          storeId: store.storeId,
          eventId,
          type: "product.updated",
          payload: {
            eventId,
            type: "product.updated",
            productId: SHIRT,
            occurredAt: new Date().toISOString(),
          },
        }),
      );
      await producer.queue.send(
        JOBS.syncProduct,
        { ...store, productId: SHIRT },
        { debounceKey: `${store.storeId}:${SHIRT}`, debounceSeconds: 5 },
      );
      await withTenant(app.db, store.tenantId, (tx) => markWebhookEnqueued(tx, recorded.id));

      const started = Date.now();
      let price: number | undefined;
      while (Date.now() - started < 10_000) {
        const variants = await withTenant(app.db, store.tenantId, (tx) =>
          getCatalogVariants(tx, store.storeId, SHIRT),
        );
        price = variants.find((v) => v.variantId === SHIRT_L)?.price;
        if (price === 777_700) break;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(price).toBe(777_700);
    } finally {
      await producer.stop();
      await worker.stop();
    }
  });
});
