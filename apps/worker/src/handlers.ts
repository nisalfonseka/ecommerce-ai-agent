import { JOBS, type JobName } from "@ace/db/jobs";
import type { PgBoss } from "pg-boss";
import type { JobHandler, WorkerDeps } from "./deps";
import { handleEmbedProduct } from "./handlers/embed";
import { handleEnrichProduct } from "./handlers/enrich";
import { handleHandoffNotify } from "./handlers/handoff-notify";
import { handleKnowledgeIngest } from "./handlers/knowledge";
import { handleOrderPlaced } from "./handlers/order-placed";
import { handleRetentionPurge } from "./handlers/retention";
import { handleShopperDelete, handleTenantOffboard } from "./handlers/shopper-delete";
import { handleShopperExport } from "./handlers/shopper-export";
import { handleSyncProduct, handleSyncReconcile, handleSyncReconcileAll } from "./handlers/sync";

export const HANDLERS: Record<JobName, JobHandler> = {
  [JOBS.syncProduct]: handleSyncProduct,
  [JOBS.syncReconcile]: handleSyncReconcile,
  [JOBS.syncReconcileAll]: handleSyncReconcileAll,
  [JOBS.enrichProduct]: handleEnrichProduct,
  [JOBS.embedProduct]: handleEmbedProduct,
  [JOBS.knowledgeIngest]: handleKnowledgeIngest,
  [JOBS.orderPlaced]: handleOrderPlaced,
  [JOBS.retentionPurge]: handleRetentionPurge,
  [JOBS.handoffNotify]: handleHandoffNotify,
  [JOBS.shopperExport]: handleShopperExport,
  [JOBS.shopperDelete]: handleShopperDelete,
  [JOBS.tenantOffboard]: handleTenantOffboard,
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
