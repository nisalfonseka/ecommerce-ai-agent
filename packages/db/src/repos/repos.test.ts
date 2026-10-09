import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, withTenant } from "../client";
import { createTestDatabase, type TestDatabase } from "../testing";
import {
  type BotInput,
  createBot,
  createStore,
  createTenant,
  getBotWithStore,
  issueWidgetKey,
  resolveWidgetKey,
  revokeWidgetKey,
} from "./admin";
import {
  acquireTurnLease,
  appendMessages,
  createConversation,
  getConversation,
  listDisplay,
  loadMessages,
  releaseLease,
  saveSessionAndRelease,
} from "./conversations";
import { monthToDateCostMicros, recordToolCalls, recordTurn, usageReport } from "./telemetry";

const testDb = await createTestDatabase();

const bot = (storeId: string): BotInput => ({
  storeId,
  persona: { assistantName: "Nila", storeName: "Demo", languages: ["English"] },
  storeFacts: { currency: "LKR" },
  model: "google:gemini-flash-latest",
  cheapModel: "google:gemini-flash-lite-latest",
  budgetSoftUsdMicros: 5_000_000,
  budgetHardUsdMicros: 10_000_000,
});

describe.skipIf(testDb === null)("repositories (as ace_app)", () => {
  let database: TestDatabase;
  let app: ReturnType<typeof createDb>;
  let tenantId: string;
  let botId: string;
  let otherTenantId: string;

  beforeAll(async () => {
    if (!testDb) return;
    database = testDb;
    app = createDb(database.appUrl);
    ({ tenantId } = await createTenant(app.db, { name: "Repo A" }));
    ({ tenantId: otherTenantId } = await createTenant(app.db, { name: "Repo B" }));
    botId = await withTenant(app.db, tenantId, async (tx) => {
      const store = await createStore(tx, tenantId, { platform: "memory", currency: "LKR" });
      return (await createBot(tx, tenantId, bot(store.id))).id;
    });
  });

  afterAll(async () => {
    await app?.close();
    await database?.drop();
  });

  describe("admin", () => {
    it("creates a tenant under a given id, so seeds can be re-run", async () => {
      const id = "00000000-0000-4000-8000-0000000000aa";
      await createTenant(app.db, { name: "Seeded", id });
      await expect(createTenant(app.db, { name: "Seeded", id })).rejects.toThrow();
      expect(
        await withTenant(app.db, id, async (tx) => (await tx.execute(sql`select 1 from tenants`)).rowCount),
      ).toBe(1);
    });

    it("issues a widget key once, stores only its hash, resolves it and stops after revocation", async () => {
      const issued = await withTenant(app.db, tenantId, (tx) =>
        issueWidgetKey(tx, tenantId, { botId, allowedOrigins: ["https://shop.test"] }),
      );
      expect(issued.key).toMatch(/^pk_live_[A-Za-z0-9_-]{32}$/);
      expect(await resolveWidgetKey(app.db, issued.key)).toEqual({
        tenantId,
        botId,
        allowedOrigins: ["https://shop.test"],
      });
      const owner = createDb(database.ownerUrl, { max: 1 });
      const dump = JSON.stringify((await owner.db.execute(sql`select * from widget_keys`)).rows);
      await owner.close();
      expect(dump).not.toContain(issued.key);
      expect(dump).toContain(createHash("sha256").update(issued.key).digest("hex"));

      await withTenant(app.db, tenantId, (tx) => revokeWidgetKey(tx, issued.keyId));
      expect(await resolveWidgetKey(app.db, issued.key)).toBeNull();
      expect(await resolveWidgetKey(app.db, "pk_live_unknown")).toBeNull();
    });

    it("loads a bot with its store, and not another tenant's bot", async () => {
      const found = await withTenant(app.db, tenantId, (tx) => getBotWithStore(tx, botId));
      expect(found?.bot.model).toBe("google:gemini-flash-latest");
      expect(found?.store.platform).toBe("memory");
      expect(await withTenant(app.db, otherTenantId, (tx) => getBotWithStore(tx, botId))).toBeNull();
    });
  });

  describe("conversations", () => {
    it("leases a conversation to one turn at a time and frees it after expiry or release", async () => {
      const conversation = await withTenant(app.db, tenantId, (tx) =>
        createConversation(tx, tenantId, { botId, visitorId: "v1", session: { shown: [] } }),
      );
      const lease = (ms: number) =>
        withTenant(app.db, tenantId, (tx) => acquireTurnLease(tx, conversation.id, ms));
      expect(await lease(60_000)).not.toBeNull();
      expect(await lease(60_000)).toBeNull();
      await withTenant(app.db, tenantId, (tx) => releaseLease(tx, conversation.id));
      expect(await lease(1)).not.toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await lease(60_000)).not.toBeNull();
    });

    it("appends messages in order, refuses a racing duplicate seq, and saves the session", async () => {
      const conversation = await withTenant(app.db, tenantId, (tx) =>
        createConversation(tx, tenantId, { botId, visitorId: "v2", session: { shown: [] } }),
      );
      const id = conversation.id;
      const toolTurn = [
        {
          kind: "model" as const,
          payload: { role: "user", content: "dresses?" },
          display: { role: "user", text: "dresses?" },
        },
        {
          kind: "model" as const,
          payload: {
            role: "assistant",
            content: [{ type: "tool-call", toolCallId: "c1", toolName: "search_products", input: {} }],
          },
        },
        {
          kind: "model" as const,
          payload: { role: "tool", content: [{ type: "tool-result", toolCallId: "c1" }] },
        },
        {
          kind: "model" as const,
          payload: { role: "assistant", content: "Here." },
          display: { role: "assistant", text: "Here.", ui: [] },
        },
      ];
      await withTenant(app.db, tenantId, (tx) => appendMessages(tx, tenantId, id, 0, toolTurn));
      await expect(
        withTenant(app.db, tenantId, (tx) =>
          appendMessages(tx, tenantId, id, 3, [
            { kind: "model", payload: { role: "user", content: "racing" } },
          ]),
        ),
      ).rejects.toThrow();
      const loaded = await withTenant(app.db, tenantId, (tx) => loadMessages(tx, id));
      expect(loaded.nextSeq).toBe(4);
      expect(loaded.rows.map((row) => row.payload)).toEqual(toolTurn.map((row) => row.payload));
      expect(await withTenant(app.db, tenantId, (tx) => listDisplay(tx, id))).toEqual([
        { role: "user", text: "dresses?" },
        { role: "assistant", text: "Here.", ui: [] },
      ]);

      await withTenant(app.db, tenantId, (tx) => acquireTurnLease(tx, id, 60_000));
      await withTenant(app.db, tenantId, (tx) =>
        saveSessionAndRelease(tx, id, { session: { shown: [{ ref: "#1" }] }, cartId: "cart_9" }),
      );
      const saved = await withTenant(app.db, tenantId, (tx) => getConversation(tx, id));
      expect(saved).toMatchObject({ session: { shown: [{ ref: "#1" }] }, cartId: "cart_9", busyUntil: null });
      expect(await withTenant(app.db, otherTenantId, (tx) => getConversation(tx, id))).toBeNull();
    });
  });

  describe("telemetry", () => {
    it("stores tool calls redacted and sums this month's cost per bot", async () => {
      const conversation = await withTenant(app.db, tenantId, (tx) =>
        createConversation(tx, tenantId, { botId, visitorId: "v3", session: {} }),
      );
      await withTenant(app.db, tenantId, async (tx) => {
        await recordToolCalls(tx, tenantId, conversation.id, "t1", [
          {
            name: "lookup_order",
            input: { note: "mail me at a@b.lk" },
            output: { ok: true },
            ok: true,
            ms: 4,
          },
        ]);
        await recordTurn(tx, tenantId, {
          conversationId: conversation.id,
          botId,
          turnId: "t1",
          model: "google:gemini-flash-latest",
          promptVersion: "p1",
          inputTokens: 100,
          outputTokens: 20,
          costUsdMicros: 1_500,
          latencyMs: 900,
          toolNames: ["lookup_order"],
          outcomes: [],
          regenerated: false,
          ungroundedCount: 0,
          error: null,
        });
      });
      const stored = await withTenant(app.db, tenantId, (tx) =>
        tx.execute<{ input_redacted: unknown }>(sql`select input_redacted from tool_calls`),
      );
      expect(stored.rows).toEqual([{ input_redacted: { note: "mail me at [email]" } }]);
      const now = new Date();
      expect(await withTenant(app.db, tenantId, (tx) => monthToDateCostMicros(tx, botId, now))).toBe(1_500);
      const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 2));
      expect(await withTenant(app.db, tenantId, (tx) => monthToDateCostMicros(tx, botId, nextMonth))).toBe(0);
      const report = await withTenant(app.db, tenantId, (tx) => usageReport(tx, now));
      expect(report).toMatchObject({ costUsdMicros: 1_500, conversations: 1, turns: 1 });
      expect(await withTenant(app.db, otherTenantId, (tx) => usageReport(tx, now))).toMatchObject({
        costUsdMicros: 0,
        conversations: 0,
      });
    });
  });
});
