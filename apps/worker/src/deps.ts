import type { CommerceProvider } from "@ace/contracts";
import type { Db } from "@ace/db";
import type { JobQueue } from "@ace/db/jobs";
import type { Embedder } from "@ace/knowledge";
import type { Enricher, StoreSearchConfig } from "@ace/search";
import type { Logger } from "pino";

export interface WorkerDeps {
  db: Db;
  jobs: JobQueue;
  logger: Logger;
  /** The store's adapter behind the idempotency layer; never the search-index decorator (the worker syncs live). */
  providerFor(tenantId: string, storeId: string): Promise<CommerceProvider>;
  storeSearchConfig(tenantId: string, storeId: string): Promise<StoreSearchConfig>;
  /** Model spec → embedder; throws for an unknown provider or a demo model in production. */
  embedderFor(spec: string): Embedder;
  /** Model spec → enricher; throws for an unknown provider or a demo model in production. */
  enricherFor(spec: string): Enricher;
  now(): Date;
}

/** The part of a pg-boss job a handler reads. `data` is unvalidated until the handler parses it. */
export interface WorkerJob {
  id: string;
  name: string;
  data: unknown;
}

export type JobHandler = (deps: WorkerDeps, job: WorkerJob) => Promise<unknown>;
