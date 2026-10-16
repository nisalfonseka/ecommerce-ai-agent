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
  handoffNotify: "handoff.notify",
  shopperExport: "privacy.export",
  shopperDelete: "privacy.delete",
  tenantOffboard: "privacy.offboard",
} as const;
export type JobName = (typeof JOBS)[keyof typeof JOBS];

const productJob = z.object({ tenantId: z.uuid(), storeId: z.uuid(), productId: z.string().min(1) });
const privacySubjectJob = z
  .object({
    tenantId: z.uuid(),
    requestId: z.uuid(),
    subjectHash: z.string().min(1).max(128).optional(),
    conversationId: z.uuid().optional(),
  })
  .refine(
    (value) => Number(value.subjectHash !== undefined) + Number(value.conversationId !== undefined) === 1,
    {
      message: "exactly one privacy subject is required",
    },
  );

export const JobPayloadSchemas = {
  [JOBS.syncProduct]: productJob,
  [JOBS.syncReconcile]: z.object({ tenantId: z.uuid(), storeId: z.uuid(), full: z.boolean() }),
  [JOBS.syncReconcileAll]: z.object({ full: z.boolean() }),
  [JOBS.enrichProduct]: productJob,
  [JOBS.embedProduct]: productJob,
  [JOBS.knowledgeIngest]: z.object({ tenantId: z.uuid(), storeId: z.uuid(), documentId: z.uuid() }),
  [JOBS.orderPlaced]: z.object({ tenantId: z.uuid(), storeId: z.uuid(), eventId: z.string().min(1) }),
  [JOBS.retentionPurge]: z.object({}),
  [JOBS.handoffNotify]: z.object({ tenantId: z.uuid(), handoffId: z.uuid() }),
  [JOBS.shopperExport]: privacySubjectJob,
  [JOBS.shopperDelete]: privacySubjectJob,
  [JOBS.tenantOffboard]: z.object({ tenantId: z.uuid(), requestId: z.uuid() }),
} satisfies { [N in JobName]: z.ZodType };

export type JobPayload<N extends JobName> = z.infer<(typeof JobPayloadSchemas)[N]>;

/** Window used when `debounceSeconds` is omitted. */
export const DEFAULT_DEBOUNCE_SECONDS = 30;

export interface JobQueue {
  /**
   * Validates the payload, then enqueues it.
   *
   * `debounceKey` contract (pg-boss debounce): a window yields a leading job plus ONE trailing job that
   * carries the second send's payload; later sends in the window are dropped. So only debounce when every
   * payload sent under the same key is equivalent (e.g. `sync.product` for one product). Never debounce a
   * payload that can differ in a meaningful field (a later `full: true` would be lost). The key is global
   * to the queue, so it must embed the tenant, store and entity identity (e.g. `${storeId}:${productId}`).
   * `debounceSeconds` defaults to DEFAULT_DEBOUNCE_SECONDS (30).
   */
  send<N extends JobName>(
    name: N,
    data: JobPayload<N>,
    options?: { debounceKey?: string; debounceSeconds?: number },
  ): Promise<void>;
}

/**
 * Debounce key for sync.reconcile, shared by the scheduled fan-out (worker) and the admin endpoint (engine) so
 * a manual and a scheduled run collapse together. It carries the mode as well as the store: a trailing job
 * keeps only one payload, so an incremental send must never swallow a full one.
 */
export function reconcileDebounceKey(storeId: string, full: boolean): string {
  return `${storeId}:${full ? "full" : "incremental"}`;
}

const JOB_NAMES = Object.values(JOBS);

/**
 * How long one attempt may run before pg-boss expires (and retries) it. A full reconcile pages a whole
 * catalogue and the purge walks every tenant, so they get an hour; ingestion fetches and embeds a document.
 */
function expireInSeconds(name: JobName): number {
  if (
    name === JOBS.syncReconcile ||
    name === JOBS.retentionPurge ||
    name === JOBS.shopperExport ||
    name === JOBS.shopperDelete ||
    name === JOBS.tenantOffboard
  )
    return 3600;
  if (name === JOBS.knowledgeIngest) return 900;
  return 300;
}

/** Jobs are idempotent (upsert by natural key), so generous retries with backoff are safe. */
function queueOptions(name: JobName) {
  return { retryLimit: 5, retryBackoff: true, retryDelay: 5, expireInSeconds: expireInSeconds(name) };
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
      // createQueue leaves an existing queue as it is; updateQueue brings deployed databases up to date.
      await boss.createQueue(name, queueOptions(name));
      await boss.updateQueue(name, queueOptions(name));
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

export interface StopJobQueueOptions {
  /**
   * Default false: stop at once (a producer has nothing in flight). A worker passes true on SIGTERM so
   * in-flight jobs finish; jobs still running after `timeoutMs` are abandoned and retried after expiry.
   */
  graceful?: boolean;
  /** Upper bound on the graceful wait. Default 30,000 ms (pg-boss's own default). */
  timeoutMs?: number;
}

/**
 * App connection (ace_app). A producer (engine) only enqueues; a worker keeps supervision and cron on.
 * Schema changes are never attempted here (`migrate: false`).
 */
export async function openJobQueue(
  appUrl: string,
  role: "producer" | "worker",
): Promise<{ queue: JobQueue; boss: PgBoss; stop(options?: StopJobQueueOptions): Promise<void> }> {
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
        await boss.sendDebounced(
          name,
          payload,
          null,
          options.debounceSeconds ?? DEFAULT_DEBOUNCE_SECONDS,
          options.debounceKey,
        );
      } else {
        await boss.send(name, payload);
      }
    },
  };
  return {
    queue,
    boss,
    stop: (options) =>
      boss.stop({ graceful: options?.graceful ?? false, timeout: options?.timeoutMs ?? 30_000, close: true }),
  };
}
