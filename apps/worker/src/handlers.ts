import { JOBS, type JobName } from "@ace/db/jobs";
import type { PgBoss } from "pg-boss";
import type { JobHandler, WorkerDeps } from "./deps";
import { handleEmbedProduct } from "./handlers/embed";
import { handleEnrichProduct } from "./handlers/enrich";
import { handleOrderPlaced } from "./handlers/order-placed";
import { handleRetentionPurge } from "./handlers/retention";
import { handleSyncProduct, handleSyncReconcile, handleSyncReconcileAll } from "./handlers/sync";

/** knowledge.ingest joins with ingestDocument (Task 10); until then its jobs wait in the queue. */
export const HANDLERS: Partial<Record<JobName, JobHandler>> = {
  [JOBS.syncProduct]: handleSyncProduct,
  [JOBS.syncReconcile]: handleSyncReconcile,
  [JOBS.syncReconcileAll]: handleSyncReconcileAll,
  [JOBS.enrichProduct]: handleEnrichProduct,
  [JOBS.embedProduct]: handleEmbedProduct,
  [JOBS.orderPlaced]: handleOrderPlaced,
  [JOBS.retentionPurge]: handleRetentionPurge,
};

export interface RegisterOptions {
  /** Jobs per queue processed in parallel by this process (WORKER_CONCURRENCY). */
  concurrency?: number;
  pollingIntervalSeconds?: number;
}

/**
 * One pg-boss worker per queue. pg-boss hands a batch (an array; batchSize 1 by default); a handler that throws
 * fails the job, which pg-boss retries with backoff (queue options in @ace/db/jobs). Handlers are idempotent.
 */
export async function registerHandlers(
  boss: Pick<PgBoss, "work">,
  deps: WorkerDeps,
  options: RegisterOptions = {},
): Promise<void> {
  for (const [name, handler] of Object.entries(HANDLERS)) {
    await boss.work(
      name,
      {
        localConcurrency: options.concurrency ?? 4,
        pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2,
      },
      async (jobs) => {
        for (const job of jobs) await handler(deps, job);
      },
    );
  }
}
