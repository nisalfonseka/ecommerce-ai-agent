import { createNotifier } from "@ace/notify";
import { loadWorkerConfig } from "./config";
import { createLogger } from "./log";
import { startWorker } from "./worker";

const config = loadWorkerConfig(process.env);
const logger = createLogger({ level: config.logLevel });
const notifier = createNotifier({ ...process.env, ACE_NOTIFY_MODE: config.notifyMode });
const worker = await startWorker({ config, logger, notifier });
logger.info({ concurrency: config.concurrency }, "worker started");

let stopping = false;
function shutdown(signal: string) {
  if (stopping) return;
  stopping = true;
  logger.info({ signal }, "worker stopping");
  void worker.stop().then(
    () => process.exit(0),
    (error: unknown) => {
      logger.error({ err: error }, "worker stop failed");
      process.exit(1);
    },
  );
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
