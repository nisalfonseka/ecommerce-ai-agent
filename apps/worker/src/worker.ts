import { createDb } from "@ace/db";
import { openJobQueue } from "@ace/db/jobs";
import type { Logger } from "pino";
import type { WorkerConfig } from "./config";
import type { WorkerDeps } from "./deps";
import { registerHandlers } from "./handlers";
import { registerSchedules } from "./schedules";
import { createWorkerDeps } from "./worker-deps";

/** How long SIGTERM waits for in-flight jobs; below Compose's stop_grace_period (30 s). */
export const GRACEFUL_STOP_MS = 25_000;

/**
 * Opens the database and the queue (worker role: supervision and cron on), registers every handler and the
 * schedules. `providerFor` is injectable so tests can share one in-memory store with the assertions.
 */
export async function startWorker(options: {
  config: WorkerConfig;
  logger: Logger;
  providerFor?: WorkerDeps["providerFor"];
}): Promise<{ stop(): Promise<void> }> {
  const { config, logger } = options;
  const { db, close } = createDb(config.databaseUrl);
  const queue = await openJobQueue(config.databaseUrl, "worker");
  try {
    const deps = createWorkerDeps({
      db,
      jobs: queue.queue,
      logger,
      masterKey: config.masterKey,
      allowDemoModels: config.allowDemoModels,
    });
    if (options.providerFor) deps.providerFor = options.providerFor;
    await registerHandlers(queue.boss, deps, { concurrency: config.concurrency });
    await registerSchedules(queue.boss, config);
  } catch (error) {
    await queue.stop();
    await close();
    throw error;
  }
  return {
    async stop() {
      // Let in-flight jobs finish (bounded); anything still running is retried after it expires.
      await queue.stop({ graceful: true, timeoutMs: GRACEFUL_STOP_MS });
      await close();
    },
  };
}
