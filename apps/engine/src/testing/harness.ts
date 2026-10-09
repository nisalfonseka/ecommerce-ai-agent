import {
  createBot,
  createDb,
  createPgIdempotencyStore,
  createStore,
  createTenant,
  issueWidgetKey,
  resolveWidgetKey,
  withTenant,
} from "@ace/db";
import type { TestDatabase } from "@ace/db/testing";
import type { LanguageModel } from "ai";
import { createApp } from "../app";
import { createConversationTokens } from "../auth/conversation-token";
import { createLogger } from "../log";
import { createProviderFactory } from "../providers";
import { createRateLimiter } from "../rate-limit";
import { registerActionRoutes } from "../routes/actions";
import { registerChatRoutes } from "../routes/chat";

export const TEST_ORIGIN = "https://shop.test";

export interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

export function parseSse(text: string): SseEvent[] {
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => ({
      event: /^event: (.*)$/m.exec(block)?.[1] ?? "message",
      data: JSON.parse(/^data: (.*)$/m.exec(block)?.[1] ?? "{}") as Record<string, unknown>,
    }));
}

/** Test-only: an engine app on a test database with one tenant, store, bot and widget key. */
export async function createEngineHarness(testDb: TestDatabase) {
  const pool = createDb(testDb.appUrl);
  const logger = createLogger({ level: "silent" });
  const models: Record<string, LanguageModel> = {};
  const providers = createProviderFactory({ idempotencyStore: (t) => createPgIdempotencyStore(pool.db, t) });
  const { tenantId } = await createTenant(pool.db, { name: "Harness" });
  const { key, storeId } = await withTenant(pool.db, tenantId, async (tx) => {
    const store = await createStore(tx, tenantId, { platform: "memory", currency: "LKR" });
    const bot = await createBot(tx, tenantId, {
      storeId: store.id,
      persona: { assistantName: "Nila", storeName: "Harness", languages: ["English"] },
      storeFacts: { currency: "LKR" },
      model: "test:primary",
      cheapModel: "test:cheap",
      budgetSoftUsdMicros: 1_000_000,
      budgetHardUsdMicros: 2_000_000,
    });
    const issued = await issueWidgetKey(tx, tenantId, { botId: bot.id, allowedOrigins: [TEST_ORIGIN] });
    return { key: issued.key, storeId: store.id };
  });
  const deps = {
    db: pool.db,
    providers,
    tokens: createConversationTokens("h".repeat(40)),
    models: (spec: string) => {
      const model = models[spec];
      if (!model) throw new Error(`no test model for ${spec}`);
      return model;
    },
    logger,
    modelRetries: 0,
    visitorLimiter: createRateLimiter({ limitPerMinute: 1000 }),
    ipLimiter: createRateLimiter({ limitPerMinute: 1000 }),
  };
  const app = createApp({
    logger,
    ping: async () => true,
    resolveWidgetKey: (k) => resolveWidgetKey(pool.db, k),
  });
  registerChatRoutes(app, deps);
  registerActionRoutes(app, deps);

  const headers = { authorization: `Bearer ${key}`, origin: TEST_ORIGIN, "content-type": "application/json" };
  return {
    app,
    pool,
    tenantId,
    models,
    provider: () => providers(tenantId, { id: storeId, platform: "memory" }),
    post: (path: string, body: unknown) =>
      app.request(path, { method: "POST", headers, body: JSON.stringify(body) }),
    async chat(body: Record<string, unknown>): Promise<SseEvent[]> {
      const res = await app.request("/v1/chat", { method: "POST", headers, body: JSON.stringify(body) });
      if (res.status !== 200) throw new Error(`chat failed: ${res.status} ${await res.text()}`);
      return parseSse(await res.text());
    },
    close: () => pool.close(),
  };
}
