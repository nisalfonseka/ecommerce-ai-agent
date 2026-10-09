import { createDb, createPgIdempotencyStore, resolveWidgetKey } from "@ace/db";
import { serve } from "@hono/node-server";
import { sql } from "drizzle-orm";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { createLogger } from "./log";
import { createProviderFactory } from "./providers";

const config = loadConfig(process.env);
const logger = createLogger({ level: config.logLevel });
const { db, close } = createDb(config.databaseUrl);
// Used by the chat routes (Task 7).
export const providers = createProviderFactory({
  idempotencyStore: (tenantId) => createPgIdempotencyStore(db, tenantId),
});

const app = createApp({
  logger,
  ping: async () => {
    try {
      await db.execute(sql`select 1`);
      return true;
    } catch {
      return false;
    }
  },
  resolveWidgetKey: (key) => resolveWidgetKey(db, key),
});

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info({ port: info.port }, "engine listening");
});

function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  server.close(() => {
    void close().finally(() => process.exit(0));
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
