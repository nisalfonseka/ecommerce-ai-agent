import { JOBS } from "@ace/db/jobs";
import { embedStoredProduct } from "@ace/search";
import type { WorkerDeps, WorkerJob } from "../deps";
import { parsePayload } from "../job";
import { indexModeConfig } from "./index-mode";

/** Embeds with the store's configured embedding model (a row embedded with another model is re-embedded). */
export async function handleEmbedProduct(deps: WorkerDeps, job: WorkerJob): Promise<void> {
  const payload = parsePayload(JOBS.embedProduct, job, deps.logger);
  if (!payload) return;
  const { tenantId, storeId, productId } = payload;
  const search = await indexModeConfig(deps, JOBS.embedProduct, job, payload);
  if (!search) return;
  const outcome = await embedStoredProduct(
    { db: deps.db, tenantId, storeId, embedder: deps.embedderFor(search.embeddingModel) },
    productId,
  );
  deps.logger.debug(
    { job: JOBS.embedProduct, jobId: job.id, tenantId, storeId, outcome },
    "product embedded",
  );
}
