import { createDb, createPgIdempotencyStore, resolveWidgetKey } from "@ace/db";
import { serve } from "@hono/node-server";
import { sql } from "drizzle-orm";
import { createApp } from "./app";
import { createConversationTokens } from "./auth/conversation-token";
import { loadConfig } from "./config";
import { createLogger } from "./log";
import { createModelResolver } from "./models";
import { createProviderFactory } from "./providers";
import { createRateLimiter } from "./rate-limit";
import { registerChatRoutes } from "./routes/chat";

const config = loadConfig(process.env);
const logger = createLogger({ level: config.logLevel });
const { db, close } = createDb(config.databaseUrl);

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

registerChatRoutes(app, {
  db,
  providers: createProviderFactory({
    idempotencyStore: (tenantId) => createPgIdempotencyStore(db, tenantId),
  }),
  tokens: createConversationTokens(config.conversationTokenSecret),
  models: createModelResolver({ allowDemo: config.allowDemoModel }),
  logger,
  visitorLimiter: createRateLimiter({ limitPerMinute: 20 }),
  ipLimiter: createRateLimiter({ limitPerMinute: 60 }),
  trustProxyHops: config.trustProxyHops,
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
