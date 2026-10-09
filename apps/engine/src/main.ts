import { readFileSync } from "node:fs";
import { createDb, createPgIdempotencyStore, resolveWidgetKey } from "@ace/db";
import { serve } from "@hono/node-server";
import { sql } from "drizzle-orm";
import { createApp } from "./app";
import { createConversationTokens } from "./auth/conversation-token";
import { loadModelPrices } from "./budget";
import { loadConfig } from "./config";
import { createLogger } from "./log";
import { createModelResolver } from "./models";
import { createProviderFactory } from "./providers";
import { createRateLimiter } from "./rate-limit";
import { registerActionRoutes } from "./routes/actions";
import { registerAdminRoutes } from "./routes/admin";
import { registerChatRoutes } from "./routes/chat";

const config = loadConfig(process.env);
// Next to the bundle in the image (dist/../model-prices.json); override with ACE_MODEL_PRICES.
const prices = loadModelPrices(
  JSON.parse(
    readFileSync(process.env.ACE_MODEL_PRICES ?? new URL("../model-prices.json", import.meta.url), "utf8"),
  ),
);
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

const turnDeps = {
  db,
  providers: createProviderFactory({
    idempotencyStore: (tenantId) => createPgIdempotencyStore(db, tenantId),
    masterKey: config.masterKey,
  }),
  tokens: createConversationTokens(config.conversationTokenSecret),
  models: createModelResolver({ allowDemo: config.allowDemoModel }),
  logger,
  prices,
  visitorLimiter: createRateLimiter({ limitPerMinute: 20 }),
  ipLimiter: createRateLimiter({ limitPerMinute: 60 }),
  trustProxyHops: config.trustProxyHops,
};
registerChatRoutes(app, turnDeps);
registerActionRoutes(app, turnDeps);
registerAdminRoutes(app, {
  db,
  adminApiKeySha256: config.adminApiKeySha256,
  masterKey: config.masterKey,
  prices,
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
