import { listSyncTargets } from "@ace/db";
import { JOBS, reconcileDebounceKey } from "@ace/db/jobs";
import { reconcileStore, type StoreSearchConfig, type SyncDeps, syncProduct } from "@ace/search";
import type { WorkerDeps, WorkerJob } from "../deps";
import { parsePayload } from "../job";
import { indexModeConfig } from "./index-mode";

async function syncDeps(
  deps: WorkerDeps,
  tenantId: string,
  storeId: string,
  search: StoreSearchConfig,
): Promise<SyncDeps> {
  return {
    db: deps.db,
    tenantId,
    storeId,
    provider: await deps.providerFor(tenantId, storeId),
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
  const search = await indexModeConfig(deps, JOBS.syncProduct, job, payload);
  if (!search) return;
  const outcome = await syncProduct(await syncDeps(deps, tenantId, storeId, search), productId);
  deps.logger.debug({ job: JOBS.syncProduct, jobId: job.id, tenantId, storeId, outcome }, "product synced");
}

export async function handleSyncReconcile(deps: WorkerDeps, job: WorkerJob): Promise<void> {
  const payload = parsePayload(JOBS.syncReconcile, job, deps.logger);
  if (!payload) return;
  const { tenantId, storeId, full } = payload;
  const search = await deps.storeSearchConfig(tenantId, storeId);
  const result = await reconcileStore(await syncDeps(deps, tenantId, storeId, search), { full });
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
