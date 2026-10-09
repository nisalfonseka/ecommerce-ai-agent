import { PgBoss } from "pg-boss";
import { z } from "zod";

export const JOB_SCHEMA = "pgboss";

export const JOBS = {
  syncProduct: "sync.product",
  syncReconcile: "sync.reconcile",
  syncReconcileAll: "sync.reconcile-all",
  enrichProduct: "enrich.product",
  embedProduct: "embed.product",
  knowledgeIngest: "knowledge.ingest",
  orderPlaced: "order.placed",
  retentionPurge: "retention.purge",
} as const;
export type JobName = (typeof JOBS)[keyof typeof JOBS];

const productJob = z.object({ tenantId: z.uuid(), storeId: z.uuid(), productId: z.string().min(1) });

export const JobPayloadSchemas = {
  [JOBS.syncProduct]: productJob,
  [JOBS.syncReconcile]: z.object({ tenantId: z.uuid(), storeId: z.uuid(), full: z.boolean() }),
  [JOBS.syncReconcileAll]: z.object({ full: z.boolean() }),
  [JOBS.enrichProduct]: productJob,
  [JOBS.embedProduct]: productJob,
  [JOBS.knowledgeIngest]: z.object({ tenantId: z.uuid(), storeId: z.uuid(), documentId: z.uuid() }),
  [JOBS.orderPlaced]: z.object({ tenantId: z.uuid(), storeId: z.uuid(), eventId: z.string().min(1) }),
  [JOBS.retentionPurge]: z.object({}),
} satisfies { [N in JobName]: z.ZodType };

export type JobPayload<N extends JobName> = z.infer<(typeof JobPayloadSchemas)[N]>;

export interface JobQueue {
  /** Validates the payload; `debounceKey` collapses bursts into one job per key per `debounceSeconds`. */
  send<N extends JobName>(
    name: N,
    data: JobPayload<N>,
    options?: { debounceKey?: string; debounceSeconds?: number },
  ): Promise<void>;
}

const JOB_NAMES = Object.values(JOBS);

/** Jobs are idempotent (upsert by natural key), so generous retries with backoff are safe. */
function queueOptions(name: JobName) {
  return {
    retryLimit: 5,
    retryBackoff: true,
    retryDelay: 5,
    expireInSeconds: name === JOBS.knowledgeIngest ? 900 : 300,
  };
}

/**
 * Owner connection: lets pg-boss create/migrate its own schema and the queues, then grants the app role
 * only DML, so the app can never alter the queue structure. Idempotent; safe to run concurrently on
 * different databases.
 */
export async function installJobSchema(ownerUrl: string): Promise<void> {
  const boss = new PgBoss({
    connectionString: ownerUrl,
    schema: JOB_SCHEMA,
    max: 2,
    migrate: true,
    supervise: false,
    schedule: false,
  });
  boss.on("error", () => undefined);
  try {
    await boss.start();
    for (const name of JOB_NAMES) {
      await boss.createQueue(name, queueOptions(name));
    }
    // Run in one statement batch through pg-boss's own pool so no extra connection is opened.
    const s = JOB_SCHEMA;
    await boss
      .getDb()
      .executeSql(
        [
          `GRANT USAGE ON SCHEMA ${s} TO ace_app`,
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${s} TO ace_app`,
          `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${s} TO ace_app`,
          `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${s} TO ace_app`,
        ].join(";\n"),
      );
  } finally {
    await boss.stop({ graceful: false, close: true });
  }
}

/**
 * App connection (ace_app). A producer (engine) only enqueues; a worker keeps supervision and cron on.
 * Schema changes are never attempted here (`migrate: false`).
 */
export async function openJobQueue(
  appUrl: string,
  role: "producer" | "worker",
): Promise<{ queue: JobQueue; boss: PgBoss; stop(): Promise<void> }> {
  const worker = role === "worker";
  const boss = new PgBoss({
    connectionString: appUrl,
    schema: JOB_SCHEMA,
    max: worker ? 10 : 3,
    migrate: false,
    createSchema: false,
    supervise: worker,
    schedule: worker,
  });
  // pg-boss emits "error" for background failures; without a listener Node would crash the process.
  boss.on("error", (err) => console.error("job queue error", err instanceof Error ? err.message : err));
  await boss.start();

  const queue: JobQueue = {
    async send(name, data, options) {
      const payload = JobPayloadSchemas[name].parse(data);
      if (options?.debounceKey) {
        await boss.sendDebounced(name, payload, null, options.debounceSeconds ?? 30, options.debounceKey);
      } else {
        await boss.send(name, payload);
      }
    },
  };
  return { queue, boss, stop: () => boss.stop({ graceful: false, close: true }) };
}
