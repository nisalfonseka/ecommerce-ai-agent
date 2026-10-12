import { randomUUID } from "node:crypto";
import pg from "pg";
import { PgBoss } from "pg-boss";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installJobSchema, JOB_SCHEMA, JOBS, openJobQueue } from "./jobs";
import { createTestDatabase, type TestDatabase } from "./testing";

const testDb = await createTestDatabase();

describe.skipIf(testDb === null)("job queue (as ace_app)", () => {
  let database: TestDatabase;
  let handle: Awaited<ReturnType<typeof openJobQueue>>;

  beforeAll(async () => {
    if (!testDb) return;
    database = testDb;
    handle = await openJobQueue(database.appUrl, "producer");
  });
  afterAll(async () => {
    await handle?.stop();
    await database?.drop();
  });

  it("installJobSchema is idempotent", async () => {
    await installJobSchema(database.ownerUrl);
    await installJobSchema(database.ownerUrl);
  });

  it("gives the long jobs a one-hour expiry, also on queues created before", async () => {
    const owner = new PgBoss({
      connectionString: database.ownerUrl,
      schema: JOB_SCHEMA,
      supervise: false,
      schedule: false,
      migrate: false,
    });
    owner.on("error", () => undefined);
    await owner.start();
    try {
      // A database installed before the change: the old five-minute expiry.
      await owner.updateQueue(JOBS.syncReconcile, { expireInSeconds: 300 });
      await owner.updateQueue(JOBS.retentionPurge, { expireInSeconds: 300 });
    } finally {
      await owner.stop({ graceful: false, close: true });
    }
    await installJobSchema(database.ownerUrl);
    const expiry = async (name: string) => (await handle.boss.getQueue(name))?.expireInSeconds;
    expect(await expiry(JOBS.syncReconcile)).toBe(3600);
    expect(await expiry(JOBS.retentionPurge)).toBe(3600);
    expect(await expiry(JOBS.syncProduct)).toBe(300);
    expect(await expiry(JOBS.knowledgeIngest)).toBe(900);
  });

  it("send then fetch returns the same data", async () => {
    const payload = { tenantId: randomUUID(), storeId: randomUUID(), productId: "p-1" };
    await handle.queue.send(JOBS.syncProduct, payload);
    const jobs = await handle.boss.fetch<typeof payload>(JOBS.syncProduct);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.data).toEqual(payload);
  });

  it("rejects an invalid payload before reaching the database", async () => {
    await expect(
      handle.queue.send(JOBS.syncProduct, { tenantId: "nope", storeId: randomUUID(), productId: "p" }),
    ).rejects.toThrow();
  });

  it("collapses a burst with the same debounceKey into a leading and one trailing job", async () => {
    const payload = { tenantId: randomUUID(), storeId: randomUUID(), full: false };
    const options = { debounceKey: "store-1", debounceSeconds: 60 };
    for (let i = 0; i < 4; i++) await handle.queue.send(JOBS.syncReconcile, payload, options);
    const [stats] = await handle.boss.getQueueStats(JOBS.syncReconcile);
    // pg-boss debounce: one immediate job plus one deferred trailing job, however large the burst.
    expect(stats?.queuedCount).toBe(2);
  });

  it("a graceful worker stop lets the in-flight job finish", async () => {
    const worker = await openJobQueue(database.appUrl, "worker");
    let started = false;
    let finished = false;
    await worker.boss.work(JOBS.retentionPurge, { pollingIntervalSeconds: 0.5 }, async () => {
      started = true;
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      finished = true;
    });
    await worker.queue.send(JOBS.retentionPurge, {});
    const deadline = Date.now() + 10_000;
    while (!started && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 100));
    expect(started).toBe(true);
    await worker.stop({ graceful: true, timeoutMs: 10_000 });
    expect(finished).toBe(true);
  });

  it("ace_app has only grants on the job schema", async () => {
    const client = new pg.Client({ connectionString: database.appUrl });
    await client.connect();
    try {
      await expect(client.query(`CREATE TABLE ${JOB_SCHEMA}.evil (id int)`)).rejects.toThrow(
        /permission denied/,
      );
    } finally {
      await client.end();
    }
  });
});
