import { MemoryCommerceProvider } from "@ace/adapter-memory";
import type { CommerceProvider } from "@ace/contracts";
import { createStore, createTenant, type Db, withTenant } from "@ace/db";
import type { JobName, JobPayload, JobQueue } from "@ace/db/jobs";
import { createDemoEmbedder, type Embedder } from "@ace/knowledge";
import { embedStoredProduct } from "./embed-product";
import { createDemoEnricher, enrichStoredProduct } from "./enrich";
import { reconcileStore } from "./sync";

/** Test-only. Drops jobs: the fixture runs enrichment and embedding itself. */
export class NullQueue implements JobQueue {
  async send<N extends JobName>(_name: N, _data: JobPayload<N>): Promise<void> {}
}

export async function newTenantStore(
  db: Db,
  tenantId?: string,
): Promise<{ tenantId: string; storeId: string }> {
  const tenant = tenantId ?? (await createTenant(db, { name: `Search ${crypto.randomUUID()}` })).tenantId;
  const storeId = await withTenant(db, tenant, async (tx) => {
    return (await createStore(tx, tenant, { platform: "memory", currency: "LKR" })).id;
  });
  return { tenantId: tenant, storeId };
}

/**
 * Test-only: a store whose index is fully synced from `provider` (sync state ready), enriched with the demo
 * enricher and embedded with `embedder` (the demo embedder by default).
 */
export async function indexedStore(
  db: Db,
  options: { tenantId?: string; provider?: CommerceProvider; embedder?: Embedder } = {},
): Promise<{ tenantId: string; storeId: string; embedder: Embedder }> {
  const ids = await newTenantStore(db, options.tenantId);
  const provider = options.provider ?? new MemoryCommerceProvider();
  const embedder = options.embedder ?? createDemoEmbedder();
  const jobs = new NullQueue();
  await reconcileStore({ db, ...ids, provider, jobs, embeddingModel: embedder.model }, { full: true });
  const { items } = await provider.listProducts({ limit: 250 });
  for (const product of items) {
    await enrichStoredProduct({ db, ...ids, enricher: createDemoEnricher(), jobs }, product.id);
    await embedStoredProduct({ db, ...ids, embedder }, product.id);
  }
  return { ...ids, embedder };
}
