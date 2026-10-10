import { JOBS } from "@ace/db/jobs";
import { type Embedder, ingestDocument } from "@ace/knowledge";
import type { WorkerDeps, WorkerJob } from "../deps";
import { parsePayload } from "../job";

/**
 * Resolves the embedder on first use, so a store whose model cannot be used (unknown provider, or a demo model
 * in production) fails inside ingestDocument and the document is marked failed instead of staying pending.
 */
function lazyEmbedder(deps: WorkerDeps, spec: string): Embedder {
  let resolved: Embedder | undefined;
  const get = () => {
    resolved ??= deps.embedderFor(spec);
    return resolved;
  };
  return {
    get model() {
      return get().model;
    },
    embed: (values, purpose) => get().embed(values, purpose),
  };
}

/**
 * Chunks and embeds an uploaded document with the store's configured embedding model. Not gated on search
 * mode: knowledge retrieval serves live-mode stores too. When embedding fails the document is marked failed
 * (its previous chunks stay) and the job throws, so pg-boss retries it; a success flips it back to ready.
 * Logs ids and the outcome only, never document content.
 */
export async function handleKnowledgeIngest(deps: WorkerDeps, job: WorkerJob): Promise<void> {
  const payload = parsePayload(JOBS.knowledgeIngest, job, deps.logger);
  if (!payload) return;
  const { tenantId, storeId, documentId } = payload;
  const search = await deps.storeSearchConfig(tenantId, storeId);
  const outcome = await ingestDocument(
    { db: deps.db, tenantId, storeId, embedder: lazyEmbedder(deps, search.embeddingModel) },
    documentId,
  );
  const fields = { job: JOBS.knowledgeIngest, jobId: job.id, tenantId, storeId, documentId, outcome };
  if (outcome === "error") {
    deps.logger.warn(fields, "knowledge ingest failed");
    throw new Error(`knowledge.ingest: embedding failed for document ${documentId}`);
  }
  deps.logger.info(fields, "knowledge ingested");
}
