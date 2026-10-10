import type { JobName } from "@ace/db/jobs";
import type { StoreSearchConfig } from "@ace/search";
import type { WorkerDeps, WorkerJob } from "../deps";

/**
 * The store's search config when it is in index mode; otherwise logs and returns null so the job completes.
 * Webhooks enqueue product jobs for every store, but only index-mode stores use the read model, so syncing,
 * enriching (a paid model call) or embedding a live-mode store's products would be wasted work.
 * sync.reconcile is not gated: an admin runs it to build the index before switching a store to index mode.
 */
export async function indexModeConfig(
  deps: WorkerDeps,
  name: JobName,
  job: WorkerJob,
  ids: { tenantId: string; storeId: string },
): Promise<StoreSearchConfig | null> {
  const search = await deps.storeSearchConfig(ids.tenantId, ids.storeId);
  if (search.mode === "index") return search;
  deps.logger.info(
    { job: name, jobId: job.id, storeId: ids.storeId },
    "job skipped: store not in index mode",
  );
  return null;
}
