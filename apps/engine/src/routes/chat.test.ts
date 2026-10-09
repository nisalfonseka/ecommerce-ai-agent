import { callTool, say, scriptedModel } from "@ace/agent/testing";
import {
  acquireTurnLease,
  createBot,
  createDb,
  createPgIdempotencyStore,
  createStore,
  createTenant,
  issueWidgetKey,
  resolveWidgetKey,
  withTenant,
} from "@ace/db";
import { createTestDatabase } from "@ace/db/testing";
import { APICallError, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createConversationTokens } from "../auth/conversation-token";
import { createLogger } from "../log";
import { createProviderFactory } from "../providers";
import { createRateLimiter } from "../rate-limit";
import { registerChatRoutes } from "./chat";

const testDb = await createTestDatabase();
const ORIGIN = "https://shop.test";

function failingModel(): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      throw new APICallError({ message: "overloaded", url: "u", requestBodyValues: {}, statusCode: 503 });
    },
  });
}

function parseSse(text: string): { event: string; data: Record<string, unknown> }[] {
  return text
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      const event = /^event: (.*)$/m.exec(block)?.[1] ?? "message";
      const data = /^data: (.*)$/m.exec(block)?.[1] ?? "{}";
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

/** The ids from the first (`conversation`) event. */
function conversationOf(events: { event: string; data: Record<string, unknown> }[]): {
  conversationId: string;
  conversationToken: string;
} {
  const data = events.find((e) => e.event === "conversation")?.data ?? {};
  return { conversationId: String(data.conversationId), conversationToken: String(data.conversationToken) };
}

describe.skipIf(testDb === null)("POST /v1/chat and GET /v1/conversations/:id", () => {
  let app: ReturnType<typeof createApp>;
  let pool: ReturnType<typeof createDb>;
  let tenantA: string;
  let tenantB: string;
  let keyA: string;
  let keyB: string;
  let fallbackKey: string;
  /** What the next turn's model returns, per model spec. */
  let models: Record<string, LanguageModel>;
  const tokens = createConversationTokens("t".repeat(40));
  const providers = (() => {
    let factory: ReturnType<typeof createProviderFactory> | undefined;
    return () => {
      factory ??= createProviderFactory({ idempotencyStore: (t) => createPgIdempotencyStore(pool.db, t) });
      return factory;
    };
  })();

  async function seed(
    name: string,
    fallbackModel: string | null,
  ): Promise<{ tenantId: string; key: string }> {
    const { tenantId } = await createTenant(pool.db, { name });
    const key = await withTenant(pool.db, tenantId, async (tx) => {
      const store = await createStore(tx, tenantId, { platform: "memory", currency: "LKR" });
      const bot = await createBot(tx, tenantId, {
        storeId: store.id,
        persona: { assistantName: "Nila", storeName: name, languages: ["English"] },
        storeFacts: { currency: "LKR" },
        model: "test:primary",
        cheapModel: "test:cheap",
        fallbackModel,
        budgetSoftUsdMicros: 1_000_000,
        budgetHardUsdMicros: 2_000_000,
      });
      return (await issueWidgetKey(tx, tenantId, { botId: bot.id, allowedOrigins: [ORIGIN] })).key;
    });
    return { tenantId, key };
  }

  beforeAll(async () => {
    if (!testDb) return;
    pool = createDb(testDb.appUrl);
    ({ tenantId: tenantA, key: keyA } = await seed("Chat A", null));
    ({ tenantId: tenantB, key: keyB } = await seed("Chat B", null));
    ({ key: fallbackKey } = await seed("Chat Fallback", "test:fallback"));
    const logger = createLogger({ level: "silent" });
    app = createApp({
      logger,
      ping: async () => true,
      resolveWidgetKey: (key) => resolveWidgetKey(pool.db, key),
    });
    registerChatRoutes(app, {
      db: pool.db,
      providers: providers(),
      tokens,
      models: (spec) => {
        const model = models[spec];
        if (!model) throw new Error(`no test model for ${spec}`);
        return model;
      },
      logger,
      modelRetries: 0,
      prices: new Map(),
      visitorLimiter: createRateLimiter({ limitPerMinute: 1000 }),
      ipLimiter: createRateLimiter({ limitPerMinute: 1000 }),
    });
  });

  afterAll(async () => {
    await pool?.close();
    await testDb?.drop();
  });

  const chat = (key: string, body: Record<string, unknown>) =>
    app.request("/v1/chat", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, origin: ORIGIN, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  async function turn(key: string, body: Record<string, unknown>) {
    const res = await chat(key, body);
    expect(res.status).toBe(200);
    return parseSse(await res.text());
  }

  it("streams conversation, status, reply and done, and persists the turn", async () => {
    models = {
      "test:primary": scriptedModel([
        callTool("c1", "search_products", { category: "dress" }),
        say("Two dresses: #1 and #2."),
      ]),
    };
    const events = await turn(keyA, { message: "show me dresses" });
    expect(events.map((e) => e.event)).toEqual(["conversation", "status", "reply", "done"]);
    expect(events[1]?.data).toEqual({ tool: "search_products" });
    const reply = events[2]?.data as { text: string; ui: { type: string }[] };
    expect(reply.text).toBe("Two dresses: #1 and #2.");
    expect(reply.ui.map((part) => part.type)).toEqual(["product_list"]);

    const { conversationId } = conversationOf(events);
    const counts = await withTenant(pool.db, tenantA, async (tx) => {
      const n = async (table: string) =>
        (await tx.execute<{ n: number }>(sql.raw(`select count(*)::int as n from ${table}`))).rows[0]?.n;
      return {
        messages: await n("messages"),
        toolCalls: await n("tool_calls"),
        traces: await n("turn_traces"),
      };
    });
    expect(counts).toEqual({ messages: 4, toolCalls: 1, traces: 1 });
    const trace = await withTenant(pool.db, tenantA, (tx) =>
      tx.execute<{ prompt_version: string; tool_names: string[]; busy_until: unknown }>(
        sql`select t.prompt_version, t.tool_names, c.busy_until from turn_traces t join conversations c on c.id = t.conversation_id where c.id = ${conversationId}`,
      ),
    );
    expect(trace.rows[0]).toMatchObject({ tool_names: ["search_products"], busy_until: null });
    expect(trace.rows[0]?.prompt_version).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
  });

  it("keeps #refs across turns and returns the cart it created", async () => {
    models = {
      "test:primary": scriptedModel([callTool("c1", "search_products", { category: "dress" }), say("Here.")]),
    };
    const first = await turn(keyA, { message: "dresses" });
    const { conversationId, conversationToken } = conversationOf(first);
    models = {
      "test:primary": scriptedModel([callTool("c1", "add_to_cart", { ref: "#2", size: "M" }), say("Added.")]),
    };
    const second = await turn(keyA, { message: "the second one in M", conversationId, conversationToken });
    const reply = second.find((e) => e.event === "reply")?.data as { cartId: string | null };
    expect(reply.cartId).toEqual(expect.any(String));
    // The factory caches one provider per (tenant, store), so this is the same store the turn wrote to.
    const storeId = await withTenant(
      pool.db,
      tenantA,
      async (tx) => (await tx.execute<{ id: string }>(sql`select id from stores limit 1`)).rows[0]?.id ?? "",
    );
    const cart = await providers()(tenantA, { id: storeId, platform: "memory" }).getCart(reply.cartId ?? "");
    expect(cart?.lines.map((line) => line.variantId)).toEqual(["p_maxi_dress_floral_m"]);
    expect(cart?.attributes.ace_conversation_id).toBe(conversationId);
  });

  it("refuses a second turn while one holds the conversation", async () => {
    models = { "test:primary": scriptedModel([say("Hi.")]) };
    const first = await turn(keyA, { message: "hi" });
    const { conversationId, conversationToken } = conversationOf(first);
    await withTenant(pool.db, tenantA, (tx) => acquireTurnLease(tx, conversationId, 60_000));
    const res = await chat(keyA, { message: "again", conversationId, conversationToken });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: { code: "turn_in_progress", message: expect.any(String) } });
  });

  it("reports a model failure as an error event and frees the conversation", async () => {
    models = { "test:primary": failingModel() };
    const events = await turn(keyA, { message: "hello" });
    expect(events.map((e) => e.event)).toEqual(["conversation", "error"]);
    expect(events[1]?.data).toMatchObject({ code: "model_unavailable" });
    const { conversationId } = conversationOf(events);
    expect(
      await withTenant(pool.db, tenantA, (tx) => acquireTurnLease(tx, conversationId, 1)),
    ).not.toBeNull();
  });

  it("falls back to the bot's fallback model when the primary fails before any tool ran", async () => {
    models = { "test:primary": failingModel(), "test:fallback": scriptedModel([say("Fallback here.")]) };
    const events = await turn(fallbackKey, { message: "hello" });
    expect(events.find((e) => e.event === "reply")?.data).toMatchObject({ text: "Fallback here." });
  });

  it("does not let another tenant's key open a conversation, even with a valid token", async () => {
    models = { "test:primary": scriptedModel([say("Hi.")]) };
    const first = await turn(keyA, { message: "hi" });
    const { conversationId, conversationToken } = conversationOf(first);
    expect((await chat(keyB, { message: "hi", conversationId, conversationToken })).status).toBe(404);
    expect(
      (await chat(keyA, { message: "hi", conversationId, conversationToken: "forged.token" })).status,
    ).toBe(404);
    const read = (key: string, token: string) =>
      app.request(`/v1/conversations/${conversationId}`, {
        headers: { authorization: `Bearer ${key}`, origin: ORIGIN, "x-conversation-token": token },
      });
    expect((await read(keyB, conversationToken)).status).toBe(404);
    expect((await read(keyA, "nope")).status).toBe(404);
    const own = await read(keyA, conversationToken);
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({
      messages: [
        { role: "user", text: "hi" },
        { role: "assistant", text: "Hi.", ui: [] },
      ],
    });
    expect(tenantB).not.toBe(tenantA);
  });

  it("scrubs a price that stays ungrounded after the retry and tags the trace", async () => {
    models = { "test:primary": scriptedModel([say("Only Rs. 999!"), say("Still Rs. 999!")]) };
    const events = await turn(keyA, { message: "price?" });
    expect(events.find((e) => e.event === "reply")?.data).toMatchObject({
      text: "Still [see the product card]!",
    });
    const { conversationId } = conversationOf(events);
    const outcomes = await withTenant(pool.db, tenantA, (tx) =>
      tx.execute<{ outcomes: string[] }>(
        sql`select outcomes from turn_traces where conversation_id = ${conversationId}`,
      ),
    );
    expect(outcomes.rows[0]?.outcomes).toEqual(expect.arrayContaining(["grounding_scrubbed", "regenerated"]));
  });

  it("rejects malformed bodies and empty messages with 400", async () => {
    expect((await chat(keyA, { nope: true })).status).toBe(400);
    expect((await chat(keyA, { message: "   " })).status).toBe(400);
  });
});
