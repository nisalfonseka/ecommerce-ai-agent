import { createHash } from "node:crypto";
import { callTool, say, scriptedModel } from "@ace/agent/testing";
import {
  acquireTurnLease,
  createBot,
  createDb,
  createDocument,
  createPgIdempotencyStore,
  createStore,
  createTenant,
  issueWidgetKey,
  resolveWidgetKey,
  sealSecret,
  setHostSessionSecret,
  withTenant,
} from "@ace/db";
import { createTestDatabase } from "@ace/db/testing";
import { createDemoEmbedder, ingestDocument } from "@ace/knowledge";
import { createProviderFactory } from "@ace/providers";
import { APICallError, type LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { createConversationTokens } from "../auth/conversation-token";
import { signHostSession } from "../identity/host-session";
import { createLogger } from "../log";
import { createRateLimiter } from "../rate-limit";
import { registerChatRoutes } from "./chat";

const testDb = await createTestDatabase();
const ORIGIN = "https://shop.test";
const MASTER_KEY = Buffer.alloc(32, 6);

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
  let storeA: string;
  /** What the next turn's model returns, per model spec. */
  let models: Record<string, LanguageModel>;
  const tokens = createConversationTokens("t".repeat(40));
  const providers = (() => {
    let factory: ReturnType<typeof createProviderFactory> | undefined;
    return () => {
      factory ??= createProviderFactory({
        idempotencyStore: (t) => createPgIdempotencyStore(pool.db, t),
        masterKey: Buffer.alloc(32, 1),
      });
      return factory;
    };
  })();

  async function seed(
    name: string,
    fallbackModel: string | null,
  ): Promise<{ tenantId: string; key: string; storeId: string }> {
    const { tenantId } = await createTenant(pool.db, { name });
    const created = await withTenant(pool.db, tenantId, async (tx) => {
      const store = await createStore(tx, tenantId, {
        platform: "memory",
        currency: "LKR",
        config: {
          search: {
            mode: "live",
            embeddingModel: "demo:hash-v1",
            enrichmentModel: "demo:rules-v1",
            knowledgeThreshold: 0.15,
          },
        },
      });
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
      const key = (await issueWidgetKey(tx, tenantId, { botId: bot.id, allowedOrigins: [ORIGIN] })).key;
      return { key, storeId: store.id };
    });
    return { tenantId, ...created };
  }

  beforeAll(async () => {
    if (!testDb) return;
    pool = createDb(testDb.appUrl);
    ({ tenantId: tenantA, key: keyA, storeId: storeA } = await seed("Chat A", null));
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
      knowledge: { embedderFor: () => createDemoEmbedder() },
      visitorLimiter: createRateLimiter({ limitPerMinute: 1000 }),
      ipLimiter: createRateLimiter({ limitPerMinute: 1000 }),
      masterKey: MASTER_KEY,
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

  it("uses a valid host session for one turn and treats an invalid token as anonymous", async () => {
    const secret = Buffer.alloc(32, 5);
    await withTenant(pool.db, tenantA, (tx) =>
      setHostSessionSecret(tx, tenantA, sealSecret(secret.toString("base64url"), MASTER_KEY)),
    );
    const token = signHostSession(
      {
        sub: "host-customer-1",
        email: "customer@example.com",
        emailVerified: true,
        exp: Math.floor(Date.now() / 1000) + 3600,
      },
      secret,
    );
    models = {
      "test:primary": scriptedModel([
        callTool("lookup", "lookup_order", { orderNumber: "ACE-1001" }),
        say("It has shipped."),
      ]),
    };
    const valid = await turn(keyA, { message: "track ACE-1001", identityToken: token });
    const validUi = valid.find((event) => event.event === "reply")?.data.ui as { type: string }[];
    expect(validUi.map((part) => part.type)).toContain("order");

    models = {
      "test:primary": scriptedModel([
        callTool("lookup", "lookup_order", { orderNumber: "ACE-1001" }),
        say("Please verify first."),
      ]),
    };
    const invalid = await turn(keyA, { message: "track ACE-1001", identityToken: `${token}x` });
    const invalidUi = invalid.find((event) => event.event === "reply")?.data.ui as { type: string }[];
    expect(invalidUi.map((part) => part.type)).toContain("verification_form");
  });

  it("wires ready store knowledge into the turn and sends cited passages to the model", async () => {
    const content = "# Exchanges\n\nItems can be exchanged within 7 days with the receipt.";
    const document = await withTenant(pool.db, tenantA, (tx) =>
      createDocument(tx, tenantA, {
        storeId: storeA,
        title: "Returns policy",
        sourceType: "markdown",
        sourceUrl: null,
        content,
        contentHash: createHash("sha256").update(content).digest("hex"),
      }),
    );
    await ingestDocument(
      {
        db: pool.db,
        tenantId: tenantA,
        storeId: storeA,
        embedder: createDemoEmbedder(),
      },
      document.id,
    );
    const model = scriptedModel([
      callTool("k1", "search_knowledge", { query: "exchange days" }),
      say("According to our Returns policy, exchanges are accepted within 7 days."),
    ]);
    models = { "test:primary": model };
    const events = await turn(keyA, { message: "How long do I have to exchange an item?" });
    expect(events.map((event) => event.event)).toEqual(["conversation", "status", "reply", "done"]);
    expect(events[1]?.data).toEqual({ tool: "search_knowledge" });
    expect(events[2]?.data).toMatchObject({ text: expect.stringContaining("Returns policy") });
    expect(JSON.stringify(model.doGenerateCalls[1])).toContain("BEGIN UNTRUSTED STORE PASSAGE");
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
    const store = await withTenant(
      pool.db,
      tenantA,
      async (tx) =>
        (await tx.execute<{ id: string; config: unknown }>(sql`select id, config from stores limit 1`))
          .rows[0],
    );
    if (!store) throw new Error("seeded store is missing");
    const cart = await providers()(tenantA, {
      id: store.id,
      platform: "memory",
      config: store.config,
    }).getCart(reply.cartId ?? "");
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
