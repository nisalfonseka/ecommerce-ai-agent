import { randomUUID } from "node:crypto";
import type { CommerceProvider } from "@ace/contracts";
import { createStore, createTenant, type Db, withTenant } from "@ace/db";
import type { JobName, JobPayload, JobQueue } from "@ace/db/jobs";
import { createDemoEmbedder } from "@ace/knowledge";
import { createDemoEnricher, parseStoreSearchConfig } from "@ace/search";
import type { WorkerDeps, WorkerJob } from "./deps";
import { createLogger } from "./log";

/** Test-only helpers for handler tests. */

export class RecordingQueue implements JobQueue {
  sent: { name: JobName; data: unknown; options?: { debounceKey?: string; debounceSeconds?: number } }[] = [];
  async send<N extends JobName>(
    name: N,
    data: JobPayload<N>,
    options?: { debounceKey?: string; debounceSeconds?: number },
  ): Promise<void> {
    this.sent.push({ name, data, options });
  }
}

/** A real (redacting) logger whose lines are kept, parsed, for assertions. */
export function capturingLogger() {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    level: "debug",
    write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
  });
  return { logger, lines };
}

export function fakeJob(name: string, data: unknown): WorkerJob {
  return { id: randomUUID(), name, data };
}

export const DEMO_SEARCH = {
  mode: "index",
  embeddingModel: "demo:hash-v1",
  enrichmentModel: "demo:rules-v1",
} as const;

export async function newStore(
  db: Db,
  search: Record<string, unknown> = DEMO_SEARCH,
  currency = "LKR",
): Promise<{ tenantId: string; storeId: string }> {
  const { tenantId } = await createTenant(db, { name: `Worker ${randomUUID()}` });
  const storeId = await withTenant(db, tenantId, async (tx) => {
    return (await createStore(tx, tenantId, { platform: "memory", currency, config: { search } })).id;
  });
  return { tenantId, storeId };
}

/** Handler deps on a test database: demo models, one injected provider for every store. */
export function testDeps(
  db: Db,
  overrides: Partial<WorkerDeps> & { provider?: CommerceProvider } = {},
): WorkerDeps & { jobs: RecordingQueue } {
  const { provider, ...rest } = overrides;
  return {
    db,
    jobs: new RecordingQueue(),
    logger: createLogger({ level: "silent" }),
    providerFor: async () => {
      if (!provider) throw new Error("no provider in this test");
      return provider;
    },
    storeSearchConfig: async () => parseStoreSearchConfig({ search: DEMO_SEARCH }),
    embedderFor: () => createDemoEmbedder(),
    enricherFor: () => createDemoEnricher(),
    now: () => new Date(),
    ...rest,
  } as WorkerDeps & { jobs: RecordingQueue };
}
