import { listSyncTargets } from "@ace/db";
import { JOBS, reconcileDebounceKey } from "@ace/db/jobs";
import { reconcileStore, type SyncDeps, syncProduct } from "@ace/search";
import type { WorkerDeps, WorkerJob } from "../deps";
import { parsePayload } from "../job";

async function syncDeps(deps: WorkerDeps, tenantId: string, storeId: string): Promise<SyncDeps> {
  const [provider, search] = await Promise.all([
    deps.providerFor(tenantId, storeId),
    deps.storeSearchConfig(tenantId, storeId),
  ]);
  return {
    db: deps.db,
    tenantId,
    storeId,
    provider,
    jobs: deps.jobs,
    embeddingModel: search.embeddingModel,
    now: deps.now,
  };
}

/** Live getProduct → read model. Product webhook events are not marked processed (only order events are). */
export async function handleSyncProduct(deps: WorkerDeps, job: WorkerJob): Promise<void> {
  const payload = parsePayload(JOBS.syncProduct, job, deps.logger);
  if (!payload) return;
  const { tenantId, storeId, productId } = payload;
  const outcome = await syncProduct(await syncDeps(deps, tenantId, storeId), productId);
  deps.logger.debug({ job: JOBS.syncProduct, jobId: job.id, tenantId, storeId, outcome }, "product synced");
}

export async function handleSyncReconcile(deps: WorkerDeps, job: WorkerJob): Promise<void> {
  const payload = parsePayload(JOBS.syncReconcile, job, deps.logger);
  if (!payload) return;
  const { tenantId, storeId, full } = payload;
  const result = await reconcileStore(await syncDeps(deps, tenantId, storeId), { full });
  deps.logger.info(
    { job: JOBS.syncReconcile, jobId: job.id, tenantId, storeId, full, ...result },
    "store reconciled",
  );
}

/**
 * Scheduled fan-out: one sync.reconcile per index-mode store of an active tenant (listSyncTargets, ADR-005),
 * debounced per store and mode (reconcileDebounceKey).
 */
export async function handleSyncReconcileAll(deps: WorkerDeps, job: WorkerJob): Promise<void> {
  const payload = parsePayload(JOBS.syncReconcileAll, job, deps.logger);
  if (!payload) return;
  const targets = await listSyncTargets(deps.db);
  for (const { tenantId, storeId } of targets) {
    await deps.jobs.send(
      JOBS.syncReconcile,
      { tenantId, storeId, full: payload.full },
      { debounceKey: reconcileDebounceKey(storeId, payload.full) },
    );
  }
  deps.logger.info(
    { job: JOBS.syncReconcileAll, jobId: job.id, full: payload.full, stores: targets.length },
    "reconcile fan-out",
  );
}
