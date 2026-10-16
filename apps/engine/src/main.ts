import { readFileSync } from "node:fs";
import { resolveEmbeddingModel } from "@ace/agent";
import { createDb, createPgIdempotencyStore, resolveWidgetKey } from "@ace/db";
import { openJobQueue } from "@ace/db/jobs";
import { embedderFor } from "@ace/knowledge";
import { createNotifier } from "@ace/notify";
import { createProviderFactory } from "@ace/providers";
import { serve } from "@hono/node-server";
import { sql } from "drizzle-orm";
import { createApp } from "./app";
import { createConversationTokens } from "./auth/conversation-token";
import { loadModelPrices } from "./budget";
import { loadConfig } from "./config";
import { createDevOutbox } from "./identity/dev-outbox";
import { createLogger } from "./log";
import { createModelResolver } from "./models";
import { createRateLimiter } from "./rate-limit";
import { registerActionRoutes } from "./routes/actions";
import { registerAdminRoutes } from "./routes/admin";
import { registerChatRoutes } from "./routes/chat";
import { registerConsentRoutes } from "./routes/consent";
import { registerDevOutboxRoute } from "./routes/dev-outbox";
import { registerStaffRoutes } from "./routes/staff";
import { registerWebhookRoutes } from "./routes/webhooks";

const config = loadConfig(process.env);
// Next to the bundle in the image (dist/../model-prices.json); override with ACE_MODEL_PRICES.
const prices = loadModelPrices(
  JSON.parse(
    readFileSync(process.env.ACE_MODEL_PRICES ?? new URL("../model-prices.json", import.meta.url), "utf8"),
  ),
);
const logger = createLogger({ level: config.logLevel });
const { db, close } = createDb(config.databaseUrl);
const notifier = createNotifier({ ...process.env, ACE_NOTIFY_MODE: config.notifyMode });
const devOutbox = !config.isProduction && config.notifyMode === "log" ? createDevOutbox() : null;
const resolveEmbedder = (spec: string) =>
  embedderFor(spec, { allowDemo: config.allowDemoModel, resolve: resolveEmbeddingModel });

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
// Producer only: the engine enqueues, the worker consumes.
const jobQueue = await openJobQueue(config.databaseUrl, "producer");

const turnDeps = {
  db,
  providers: createProviderFactory({
    idempotencyStore: (tenantId) => createPgIdempotencyStore(db, tenantId),
    masterKey: config.masterKey,
    // Index-mode stores (config.search.mode) search the read model; demo:* embedders only outside production.
    index: {
      db,
      embedderFor: resolveEmbedder,
    },
    logger,
  }),
  tokens: createConversationTokens(config.conversationTokenSecret),
  models: createModelResolver({ allowDemo: config.allowDemoModel }),
  logger,
  prices,
  knowledge: { embedderFor: resolveEmbedder },
  masterKey: config.masterKey,
  visitorLimiter: createRateLimiter({ limitPerMinute: 20 }),
  ipLimiter: createRateLimiter({ limitPerMinute: 60 }),
  trustProxyHops: config.trustProxyHops,
  otp: {
    db,
    notifier,
    masterKey: config.masterKey,
    ipLimiter: createRateLimiter({ limit: 20, windowMs: 60 * 60 * 1000 }),
    ...(devOutbox ? { outbox: devOutbox } : {}),
  },
  jobs: jobQueue.queue,
};
registerChatRoutes(app, turnDeps);
registerConsentRoutes(app, { db, tokens: turnDeps.tokens });
registerActionRoutes(app, turnDeps);
registerDevOutboxRoute(app, devOutbox ? { outbox: devOutbox, tokens: turnDeps.tokens } : null);
registerStaffRoutes(app, { db, jobs: jobQueue.queue });
registerAdminRoutes(app, {
  db,
  adminApiKeySha256: config.adminApiKeySha256,
  masterKey: config.masterKey,
  prices,
  jobs: jobQueue.queue,
});
registerWebhookRoutes(app, { db, jobs: jobQueue.queue, masterKey: config.masterKey, logger });

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info({ port: info.port }, "engine listening");
});

function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  server.close(() => {
    void Promise.allSettled([jobQueue.stop(), close()]).finally(() => process.exit(0));
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
