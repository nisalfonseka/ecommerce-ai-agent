import { JOBS } from "@ace/db/jobs";
import { enrichStoredProduct } from "@ace/search";
import type { WorkerDeps, WorkerJob } from "../deps";
import { parsePayload } from "../job";

/** Enriches with the store's configured enrichment model; usage is billed to `job:<pg-boss job id>`. */
export async function handleEnrichProduct(deps: WorkerDeps, job: WorkerJob): Promise<void> {
  const payload = parsePayload(JOBS.enrichProduct, job, deps.logger);
  if (!payload) return;
  const { tenantId, storeId, productId } = payload;
  const search = await deps.storeSearchConfig(tenantId, storeId);
  const outcome = await enrichStoredProduct(
    {
      db: deps.db,
      tenantId,
      storeId,
      enricher: deps.enricherFor(search.enrichmentModel),
      jobs: deps.jobs,
      jobId: job.id,
      onBillingError: (error) =>
        // The error's name only: a failed insert's message can quote the statement's parameters.
        deps.logger.error(
          {
            job: JOBS.enrichProduct,
            jobId: job.id,
            tenantId,
            storeId,
            error: error instanceof Error ? error.name : "unknown",
          },
          "enrichment usage not recorded",
        ),
    },
    productId,
  );
  deps.logger.debug(
    { job: JOBS.enrichProduct, jobId: job.id, tenantId, storeId, outcome },
    "product enriched",
  );
}
