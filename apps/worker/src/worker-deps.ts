import { resolveEmbeddingModel, resolveModel } from "@ace/agent";
import { createPgIdempotencyStore, type Db, schema, withTenant } from "@ace/db";
import type { JobQueue } from "@ace/db/jobs";
import { embedderFor } from "@ace/knowledge";
import { createProviderFactory } from "@ace/providers";
import { createDemoEnricher, createLlmEnricher, type Enricher, parseStoreSearchConfig } from "@ace/search";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import type { WorkerDeps } from "./deps";

async function loadStore(db: Db, tenantId: string, storeId: string) {
  const [store] = await withTenant(db, tenantId, (tx) =>
    tx
      .select({
        id: schema.stores.id,
        platform: schema.stores.platform,
        credentialsSealed: schema.stores.credentialsSealed,
        config: schema.stores.config,
      })
      .from(schema.stores)
      .where(eq(schema.stores.id, storeId)),
  );
  // Ids only: a job for a deleted store fails and is retried, then given up by pg-boss.
  if (!store) throw new Error(`store ${storeId} not found for tenant ${tenantId}`);
  return store;
}

/**
 * Production wiring. The provider factory gets no `index`: the worker reads the live adapter (behind the
 * idempotency layer), never the search-index decorator it is filling.
 */
export function createWorkerDeps(input: {
  db: Db;
  jobs: JobQueue;
  logger: Logger;
  masterKey: Buffer;
  allowDemoModels: boolean;
  now?: () => Date;
}): WorkerDeps {
  const { db, logger, allowDemoModels } = input;
  const providers = createProviderFactory({
    idempotencyStore: (tenantId) => createPgIdempotencyStore(db, tenantId),
    masterKey: input.masterKey,
    logger,
  });
  return {
    db,
    jobs: input.jobs,
    logger,
    providerFor: async (tenantId, storeId) => providers(tenantId, await loadStore(db, tenantId, storeId)),
    storeSearchConfig: async (tenantId, storeId) =>
      parseStoreSearchConfig((await loadStore(db, tenantId, storeId)).config),
    embedderFor: (spec) => embedderFor(spec, { allowDemo: allowDemoModels, resolve: resolveEmbeddingModel }),
    enricherFor: (spec): Enricher => {
      if (spec.startsWith("demo:")) {
        if (!allowDemoModels) throw new Error(`Enrichment model "${spec}" is not allowed in production.`);
        return createDemoEnricher();
      }
      return createLlmEnricher(spec, resolveModel(spec));
    },
    now: input.now ?? (() => new Date()),
  };
}
