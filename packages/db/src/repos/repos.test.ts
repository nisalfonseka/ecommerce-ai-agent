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
import { getLatestConsent, recordConsent } from "./consents";
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
import {
  createHandoff,
  getActiveHandoff,
  getHandoff,
  getHandoffContactSealed,
  listHandoffs,
  markHandoffNotified,
  transitionHandoff,
} from "./handoffs";
import {
  createPrivacyRequest,
  finishPrivacyRequest,
  getPrivacyRequest,
  listPrivacyRequests,
} from "./privacy";
import { createStaffToken, findStaffToken, listStaffTokens, revokeStaffToken } from "./staff";
import { monthToDateCostMicros, recordJobUsage, recordToolCalls, recordTurn, usageReport } from "./telemetry";
import {
  getHostSessionSecretSealed,
  getRetention,
  getTenantSettings,
  setHostSessionSecret,
  upsertTenantSettings,
} from "./tenant-settings";
import {
  consumeVerification,
  countRecentStarts,
  createVerification,
  getPendingVerification,
  reserveAttempt,
} from "./verifications";
import {
  getWebhookEvent,
  markWebhookEnqueued,
  markWebhookProcessed,
  recordWebhookEvent,
  setStoreWebhookSecret,
} from "./webhooks";

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

    it("counts only turns as turns once job usage shares the ledger", async () => {
      const enrichTenant = (await createTenant(app.db, { name: "Enrich usage" })).tenantId;
      const storeId = await withTenant(
        app.db,
        enrichTenant,
        async (tx) => (await createStore(tx, enrichTenant, { platform: "memory", currency: "LKR" })).id,
      );
      await withTenant(app.db, enrichTenant, (tx) =>
        recordJobUsage(tx, enrichTenant, {
          storeId,
          kind: "enrich",
          turnId: "job:j1",
          model: "google:cheap",
          inputTokens: 10,
          outputTokens: 5,
        }),
      );
      expect(await withTenant(app.db, enrichTenant, (tx) => usageReport(tx, new Date()))).toMatchObject({
        turns: 0,
        costUsdMicros: 0,
      });
    });
  });
  describe("webhooks", () => {
    it("records an event once, tracks enqueue and processing, and rotates the store secret", async () => {
      const storeId = await withTenant(app.db, tenantId, async (tx) => {
        const [row] = await tx
          .execute<{ id: string }>(sql`select id from stores limit 1`)
          .then((r) => r.rows);
        return row?.id ?? "";
      });
      const event = { storeId, eventId: "product.updated:p_1:1", type: "product.updated", payload: { a: 1 } };
      const first = await withTenant(app.db, tenantId, (tx) => recordWebhookEvent(tx, tenantId, event));
      expect(first).toMatchObject({ isNew: true, enqueuedAt: null });
      const again = await withTenant(app.db, tenantId, (tx) => recordWebhookEvent(tx, tenantId, event));
      expect(again).toMatchObject({ id: first.id, isNew: false, enqueuedAt: null });
      await withTenant(app.db, tenantId, (tx) => markWebhookEnqueued(tx, first.id));
      const third = await withTenant(app.db, tenantId, (tx) => recordWebhookEvent(tx, tenantId, event));
      expect(third.isNew).toBe(false);
      expect(third.enqueuedAt).toBeInstanceOf(Date);
      await withTenant(app.db, tenantId, (tx) => markWebhookProcessed(tx, storeId, event.eventId));
      const processed = await withTenant(app.db, tenantId, (tx) =>
        tx.execute<{ processed_at: Date | null }>(sql`select processed_at from webhook_events`),
      );
      expect(processed.rows[0]?.processed_at).toBeTruthy();
      expect(await withTenant(app.db, tenantId, (tx) => getWebhookEvent(tx, storeId, event.eventId))).toEqual(
        {
          type: "product.updated",
          payload: { a: 1 },
        },
      );
      expect(await withTenant(app.db, tenantId, (tx) => getWebhookEvent(tx, storeId, "nope"))).toBeNull();
      // Another tenant sees nothing and cannot touch the store.
      expect(
        await withTenant(app.db, otherTenantId, (tx) => getWebhookEvent(tx, storeId, event.eventId)),
      ).toBeNull();
      expect(
        await withTenant(app.db, otherTenantId, (tx) => setStoreWebhookSecret(tx, storeId, Buffer.from("x"))),
      ).toBe(false);
      expect(
        await withTenant(app.db, tenantId, (tx) => setStoreWebhookSecret(tx, storeId, Buffer.from("x"))),
      ).toBe(true);
    });
  });
  describe("tenant settings", () => {
    it("returns the defaults for a tenant with no settings row", async () => {
      const fresh = (await createTenant(app.db, { name: "No settings" })).tenantId;
      const settings = await withTenant(app.db, fresh, (tx) => getTenantSettings(tx));
      expect(settings).toMatchObject({
        handoffEmails: [],
        otp: { allowedCountryCodes: ["94"], channels: ["sms", "email"] },
        requireConsent: true,
        privacyNoticeUrl: null,
        contactInfo: null,
        hasHostSessionSecret: false,
      });
      expect(getRetention(settings)).toEqual({
        messagesDays: 180,
        tracesDays: 30,
        handoffDays: 180,
        otpHours: 24,
      });
    });

    it("upserts one row per tenant, keeps fields a patch does not mention, and isolates tenants", async () => {
      const tenant = (await createTenant(app.db, { name: "Settings tenant" })).tenantId;
      const other = (await createTenant(app.db, { name: "Settings other" })).tenantId;
      await withTenant(app.db, tenant, (tx) =>
        upsertTenantSettings(tx, tenant, { retention: { messagesDays: 90 }, handoffEmails: ["a@shop.lk"] }),
      );
      const second = await withTenant(app.db, tenant, (tx) =>
        upsertTenantSettings(tx, tenant, {
          contactInfo: "Call 011 234 5678",
          otp: { allowedCountryCodes: ["94"], channels: ["email"] },
        }),
      );
      expect(second).toMatchObject({
        retention: { messagesDays: 90 },
        handoffEmails: ["a@shop.lk"],
        contactInfo: "Call 011 234 5678",
        otp: { allowedCountryCodes: ["94"], channels: ["email"] },
      });
      const rows = await withTenant(app.db, tenant, (tx) =>
        tx.execute(sql`select count(*)::int as n from tenant_settings`),
      );
      expect(rows.rows[0]).toEqual({ n: 1 });
      expect(await withTenant(app.db, other, (tx) => getTenantSettings(tx))).toMatchObject({
        handoffEmails: [],
        contactInfo: null,
      });
    });

    it("merges a retention patch into the stored retention instead of replacing it", async () => {
      const tenant = (await createTenant(app.db, { name: "Retention merge" })).tenantId;
      const upsert = (patch: Parameters<typeof upsertTenantSettings>[2]) =>
        withTenant(app.db, tenant, (tx) => upsertTenantSettings(tx, tenant, patch));
      await upsert({ retention: { messagesDays: 30 } });
      const merged = await upsert({ retention: { otpHours: 12 } });
      expect(merged.retention).toEqual({ messagesDays: 30, otpHours: 12 });
      expect(getRetention(merged)).toEqual({
        messagesDays: 30,
        tracesDays: 30,
        handoffDays: 180,
        otpHours: 12,
      });
      // A key the patch names is overwritten; an empty patch object changes nothing.
      expect((await upsert({ retention: { messagesDays: 60 } })).retention).toEqual({
        messagesDays: 60,
        otpHours: 12,
      });
      expect((await upsert({ retention: {} })).retention).toEqual({ messagesDays: 60, otpHours: 12 });
      expect((await withTenant(app.db, tenant, (tx) => getTenantSettings(tx))).retention).toEqual({
        messagesDays: 60,
        otpHours: 12,
      });
    });

    it("merges an otp patch, keeping the fields it does not mention", async () => {
      const tenant = (await createTenant(app.db, { name: "Otp merge" })).tenantId;
      const upsert = (patch: Parameters<typeof upsertTenantSettings>[2]) =>
        withTenant(app.db, tenant, (tx) => upsertTenantSettings(tx, tenant, patch));
      await upsert({ otp: { allowedCountryCodes: ["94", "91"], channels: ["sms", "email"] } });
      expect((await upsert({ otp: { channels: ["email"] } })).otp).toEqual({
        allowedCountryCodes: ["94", "91"],
        channels: ["email"],
      });
      expect((await upsert({ otp: { allowedCountryCodes: ["94"] } })).otp).toEqual({
        allowedCountryCodes: ["94"],
        channels: ["email"],
      });
      // Other fields are untouched by an otp-only patch, and the stored defaults apply to a fresh tenant.
      const fresh = (await createTenant(app.db, { name: "Otp fresh" })).tenantId;
      const first = await withTenant(app.db, fresh, (tx) =>
        upsertTenantSettings(tx, fresh, { otp: { channels: ["email"] } }),
      );
      expect(first.otp).toEqual({ allowedCountryCodes: ["94"], channels: ["email"] });
    });

    it("recovers from a stored retention that is not an object, instead of nesting it", async () => {
      const tenant = (await createTenant(app.db, { name: "Corrupt retention" })).tenantId;
      await withTenant(app.db, tenant, async (tx) => {
        await upsertTenantSettings(tx, tenant, { requireConsent: false });
        await tx.execute(sql`update tenant_settings set retention = '"forever"'::jsonb`);
      });
      const patched = await withTenant(app.db, tenant, (tx) =>
        upsertTenantSettings(tx, tenant, { retention: { otpHours: 6 } }),
      );
      expect(patched.retention).toEqual({ otpHours: 6 });
      expect(patched.requireConsent).toBe(false);
    });

    it("rejects an invalid patch before it reaches the database", async () => {
      await expect(
        withTenant(app.db, tenantId, (tx) =>
          upsertTenantSettings(tx, tenantId, { retention: { otpHours: 500 } }),
        ),
      ).rejects.toThrow();
    });

    it("stores the sealed host-session secret apart from the readable settings", async () => {
      const tenant = (await createTenant(app.db, { name: "Host secret" })).tenantId;
      expect(await withTenant(app.db, tenant, (tx) => getHostSessionSecretSealed(tx))).toBeNull();
      await withTenant(app.db, tenant, (tx) => setHostSessionSecret(tx, tenant, Buffer.from("sealed-bytes")));
      expect(
        (await withTenant(app.db, tenant, (tx) => getHostSessionSecretSealed(tx)))?.toString("utf8"),
      ).toBe("sealed-bytes");
      const settings = await withTenant(app.db, tenant, (tx) => getTenantSettings(tx));
      expect(settings.hasHostSessionSecret).toBe(true);
      expect(JSON.stringify(settings)).not.toContain("sealed-bytes");
      await withTenant(app.db, tenant, (tx) => setHostSessionSecret(tx, tenant, null));
      expect(await withTenant(app.db, tenant, (tx) => getHostSessionSecretSealed(tx))).toBeNull();
    });
  });

  describe("verifications", () => {
    const newConversation = (visitorId: string) =>
      withTenant(app.db, tenantId, (tx) =>
        createConversation(tx, tenantId, { botId, visitorId, session: {} }),
      );
    const input = (conversationId: string, over: { destinationHash?: string; expiresAt?: Date } = {}) => ({
      conversationId,
      channel: "email" as const,
      destinationHash: over.destinationHash ?? "dest_1",
      destinationSealed: Buffer.from("sealed"),
      codeHash: "code_hash",
      salt: "salt_1",
      expiresAt: over.expiresAt ?? new Date(Date.now() + 600_000),
    });

    it("keeps one pending code per conversation: a new code invalidates the old one", async () => {
      const { id } = await newConversation("ver-1");
      const first = await withTenant(app.db, tenantId, (tx) => createVerification(tx, tenantId, input(id)));
      expect(first).toMatchObject({ attempts: 0, consumedAt: null, channel: "email" });
      const second = await withTenant(app.db, tenantId, (tx) =>
        createVerification(tx, tenantId, { ...input(id), codeHash: "newer", salt: "salt_2" }),
      );
      const pending = await withTenant(app.db, tenantId, (tx) => getPendingVerification(tx, id, new Date()));
      expect(pending?.id).toBe(second.id);
      expect(
        await withTenant(app.db, tenantId, (tx) => consumeVerification(tx, first.id, new Date())),
        "the invalidated code must not be consumable",
      ).toBe(false);
    });

    it("stores only the fields it is given: a wider input object cannot set attempts, state or tenant", async () => {
      const { id } = await newConversation("ver-0");
      const sneaky = {
        ...input(id),
        attempts: 4,
        consumedAt: new Date(),
        tenantId: otherTenantId,
      };
      const row = await withTenant(app.db, tenantId, (tx) => createVerification(tx, tenantId, sneaky));
      expect(row).toMatchObject({ attempts: 0, consumedAt: null, tenantId });
    });

    it("does not return an expired code, and refuses to consume it", async () => {
      const { id } = await newConversation("ver-2");
      const row = await withTenant(app.db, tenantId, (tx) =>
        createVerification(tx, tenantId, input(id, { expiresAt: new Date(Date.now() + 1_000) })),
      );
      const later = new Date(Date.now() + 5_000);
      expect(await withTenant(app.db, tenantId, (tx) => getPendingVerification(tx, id, later))).toBeNull();
      expect(await withTenant(app.db, tenantId, (tx) => consumeVerification(tx, row.id, later))).toBe(false);
    });

    it("reserves an attempt before the code is compared, and never beyond the cap, even in parallel", async () => {
      const { id } = await newConversation("ver-3");
      const row = await withTenant(app.db, tenantId, (tx) => createVerification(tx, tenantId, input(id)));
      const now = new Date();
      const results = await Promise.all(
        Array.from({ length: 20 }, () =>
          withTenant(app.db, tenantId, (tx) => reserveAttempt(tx, row.id, 5, now)),
        ),
      );
      const reserved = results.filter((n): n is number => n !== null);
      // 20 simultaneous guesses against a cap of 5: exactly 5 get to compare the code, numbered 1..5.
      expect(reserved.sort()).toEqual([1, 2, 3, 4, 5]);
      const stored = await withTenant(app.db, tenantId, (tx) => getPendingVerification(tx, id, now));
      expect(stored?.attempts).toBe(5);
      expect(await withTenant(app.db, tenantId, (tx) => reserveAttempt(tx, row.id, 5, now))).toBeNull();
    });

    it("refuses to reserve an attempt on a consumed, expired or unknown code, or a nonsense cap", async () => {
      const { id } = await newConversation("ver-3b");
      const row = await withTenant(app.db, tenantId, (tx) =>
        createVerification(tx, tenantId, input(id, { expiresAt: new Date(Date.now() + 60_000) })),
      );
      const reserve = (target: string, now = new Date()) =>
        withTenant(app.db, tenantId, (tx) => reserveAttempt(tx, target, 5, now));
      expect(await reserve(row.id, new Date(Date.now() + 120_000)), "expired").toBeNull();
      expect(await reserve("00000000-0000-4000-8000-000000000000"), "unknown").toBeNull();
      expect(await reserve(row.id), "live").toBe(1);
      expect(await withTenant(app.db, tenantId, (tx) => consumeVerification(tx, row.id, new Date()))).toBe(
        true,
      );
      expect(await reserve(row.id), "consumed").toBeNull();
      await expect(
        withTenant(app.db, tenantId, (tx) => reserveAttempt(tx, row.id, 0, new Date())),
      ).rejects.toThrow(/maxAttempts/);
      await expect(
        withTenant(app.db, otherTenantId, (tx) => reserveAttempt(tx, row.id, 5, new Date())),
      ).resolves.toBeNull();
    });

    it("lets a code be consumed exactly once, however many consume it at the same time", async () => {
      const { id } = await newConversation("ver-3c");
      const row = await withTenant(app.db, tenantId, (tx) => createVerification(tx, tenantId, input(id)));
      const consumed = await Promise.all(
        [1, 2, 3, 4].map(() =>
          withTenant(app.db, tenantId, (tx) => consumeVerification(tx, row.id, new Date())),
        ),
      );
      expect(consumed.filter(Boolean)).toHaveLength(1);
      expect(
        await withTenant(app.db, tenantId, (tx) => getPendingVerification(tx, id, new Date())),
      ).toBeNull();
    });

    it("counts starts per conversation and per destination inside a window, for rate limits", async () => {
      const a = await newConversation("ver-4a");
      const b = await newConversation("ver-4b");
      const dest = `dest_${a.id}`;
      await withTenant(app.db, tenantId, async (tx) => {
        await createVerification(tx, tenantId, input(a.id, { destinationHash: dest }));
        await createVerification(tx, tenantId, input(a.id, { destinationHash: dest }));
        await createVerification(tx, tenantId, input(b.id, { destinationHash: dest }));
        await createVerification(tx, tenantId, input(b.id, { destinationHash: "elsewhere" }));
      });
      const hourAgo = new Date(Date.now() - 3_600_000);
      const count = (filter: { conversationId?: string; destinationHash?: string }, since = hourAgo) =>
        withTenant(app.db, tenantId, (tx) => countRecentStarts(tx, { ...filter, since }));
      // Invalidated codes still count: a start is a start.
      expect(await count({ conversationId: a.id })).toBe(2);
      expect(await count({ destinationHash: dest })).toBe(3);
      expect(await count({ conversationId: b.id, destinationHash: dest })).toBe(1);
      expect(await count({ destinationHash: dest }, new Date(Date.now() + 60_000))).toBe(0);
      expect(
        await withTenant(app.db, otherTenantId, (tx) =>
          countRecentStarts(tx, { destinationHash: dest, since: hourAgo }),
        ),
      ).toBe(0);
      await expect(
        withTenant(app.db, tenantId, (tx) => countRecentStarts(tx, { since: hourAgo })),
      ).rejects.toThrow(/conversationId or destinationHash/);
    });

    it("is deleted with its conversation", async () => {
      const { id } = await newConversation("ver-5");
      await withTenant(app.db, tenantId, (tx) => createVerification(tx, tenantId, input(id)));
      await withTenant(app.db, tenantId, (tx) =>
        recordConsent(tx, tenantId, { conversationId: id, noticeVersion: "v1" }),
      );
      await withTenant(app.db, tenantId, (tx) =>
        createHandoff(tx, tenantId, { conversationId: id, reason: "other", summary: "s" }),
      );
      await withTenant(app.db, tenantId, (tx) => tx.execute(sql`delete from conversations where id = ${id}`));
      const left = await withTenant(app.db, tenantId, (tx) =>
        tx.execute<{ n: number }>(sql`
          select (select count(*) from verifications where conversation_id = ${id})::int
               + (select count(*) from consents where conversation_id = ${id})::int
               + (select count(*) from handoffs where conversation_id = ${id})::int as n`),
      );
      expect(left.rows[0]?.n).toBe(0);
    });
  });

  describe("consents", () => {
    it("records a notice version once per conversation and returns the latest consent", async () => {
      const { id } = await withTenant(app.db, tenantId, (tx) =>
        createConversation(tx, tenantId, { botId, visitorId: "consent-1", session: {} }),
      );
      expect(await withTenant(app.db, tenantId, (tx) => getLatestConsent(tx, id))).toBeNull();
      const first = await withTenant(app.db, tenantId, (tx) =>
        recordConsent(tx, tenantId, {
          conversationId: id,
          noticeVersion: "2027-01",
          noticeUrl: "https://shop.lk/p",
        }),
      );
      expect(first).toBe(true);
      const again = await withTenant(app.db, tenantId, (tx) =>
        recordConsent(tx, tenantId, { conversationId: id, noticeVersion: "2027-01" }),
      );
      expect(again).toBe(false);
      expect(await withTenant(app.db, tenantId, (tx) => getLatestConsent(tx, id))).toMatchObject({
        noticeVersion: "2027-01",
        noticeUrl: "https://shop.lk/p",
      });
      expect(await withTenant(app.db, otherTenantId, (tx) => getLatestConsent(tx, id))).toBeNull();
    });
  });

  describe("handoffs", () => {
    const newHandoff = async (visitorId: string) => {
      const conversation = await withTenant(app.db, tenantId, (tx) =>
        createConversation(tx, tenantId, { botId, visitorId, session: {} }),
      );
      const { handoff } = await withTenant(app.db, tenantId, (tx) =>
        createHandoff(tx, tenantId, {
          conversationId: conversation.id,
          reason: "refund_or_return",
          summary: "Wants a refund",
          contactSealed: Buffer.from("sealed-contact"),
        }),
      );
      return { conversation, handoff };
    };

    it("creates one active handoff per conversation, and a new one after it is resolved", async () => {
      const { conversation, handoff } = await newHandoff("ho-1");
      expect(handoff).toMatchObject({ status: "open", claimedBy: null, notifiedAt: null, resolvedAt: null });
      const again = await withTenant(app.db, tenantId, (tx) =>
        createHandoff(tx, tenantId, { conversationId: conversation.id, reason: "other", summary: "second" }),
      );
      expect(again.created).toBe(false);
      expect(again.handoff.id).toBe(handoff.id);
      expect(again.handoff.summary).toBe("Wants a refund");

      const resolved = await withTenant(app.db, tenantId, (tx) =>
        transitionHandoff(tx, handoff.id, { to: "resolved" }),
      );
      expect(resolved.ok).toBe(true);
      expect(await withTenant(app.db, tenantId, (tx) => getActiveHandoff(tx, conversation.id))).toBeNull();
      const next = await withTenant(app.db, tenantId, (tx) =>
        createHandoff(tx, tenantId, { conversationId: conversation.id, reason: "other", summary: "again" }),
      );
      expect(next.created).toBe(true);
      expect(next.handoff.id).not.toBe(handoff.id);
    });

    it("moves open to claimed to resolved and rejects going backwards or repeating", async () => {
      const { handoff } = await newHandoff("ho-2");
      const transition = (t: Parameters<typeof transitionHandoff>[2], tenant = tenantId) =>
        withTenant(app.db, tenant, (tx) => transitionHandoff(tx, handoff.id, t));

      const claimed = await transition({ to: "claimed", claimedBy: "Nimali" });
      expect(claimed).toMatchObject({ ok: true, handoff: { status: "claimed", claimedBy: "Nimali" } });
      expect(await transition({ to: "claimed", claimedBy: "Kasun" })).toEqual({
        ok: false,
        reason: "conflict",
        status: "claimed",
      });
      expect((await withTenant(app.db, tenantId, (tx) => getHandoff(tx, handoff.id)))?.claimedBy).toBe(
        "Nimali",
      );

      const resolved = await transition({ to: "resolved" });
      expect(resolved).toMatchObject({ ok: true, handoff: { status: "resolved", claimedBy: "Nimali" } });
      if (resolved.ok) expect(resolved.handoff.resolvedAt).toBeInstanceOf(Date);

      expect(await transition({ to: "claimed", claimedBy: "Kasun" })).toMatchObject({
        ok: false,
        reason: "conflict",
      });
      expect(await transition({ to: "resolved" })).toMatchObject({ ok: false, reason: "conflict" });
      expect((await withTenant(app.db, tenantId, (tx) => getHandoff(tx, handoff.id)))?.status).toBe(
        "resolved",
      );
    });

    it("can resolve straight from open, and treats another tenant's handoff as not found", async () => {
      const { handoff } = await newHandoff("ho-3");
      expect(
        await withTenant(app.db, otherTenantId, (tx) =>
          transitionHandoff(tx, handoff.id, { to: "resolved" }),
        ),
      ).toEqual({ ok: false, reason: "not_found" });
      expect(await withTenant(app.db, otherTenantId, (tx) => getHandoff(tx, handoff.id))).toBeNull();
      const done = await withTenant(app.db, tenantId, (tx) =>
        transitionHandoff(tx, handoff.id, { to: "resolved" }),
      );
      expect(done).toMatchObject({ ok: true, handoff: { status: "resolved", claimedBy: null } });
    });

    it("lets exactly one of two simultaneous claims win", async () => {
      const { handoff } = await newHandoff("ho-4");
      const results = await Promise.all(
        ["Nimali", "Kasun"].map((name) =>
          withTenant(app.db, tenantId, (tx) =>
            transitionHandoff(tx, handoff.id, { to: "claimed", claimedBy: name }),
          ),
        ),
      );
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: "conflict", status: "claimed" }]);
      const stored = await withTenant(app.db, tenantId, (tx) => getHandoff(tx, handoff.id));
      const winner = results.find((r) => r.ok);
      expect(winner?.ok && winner.handoff.claimedBy).toBe(stored?.claimedBy);
    });

    it("never returns the sealed contact from a handoff read; one dedicated reader does", async () => {
      const { conversation, handoff } = await newHandoff("ho-6");
      const claimed = await withTenant(app.db, tenantId, (tx) =>
        transitionHandoff(tx, handoff.id, { to: "claimed", claimedBy: "Nimali" }),
      );
      if (!claimed.ok) throw new Error("claim failed");
      const again = await withTenant(app.db, tenantId, (tx) =>
        createHandoff(tx, tenantId, { conversationId: conversation.id, reason: "x", summary: "y" }),
      );
      const rows: object[] = [
        handoff,
        claimed.handoff,
        again.handoff,
        ...(await withTenant(app.db, tenantId, (tx) => listHandoffs(tx, { limit: 200 }))),
      ];
      const fetched = await withTenant(app.db, tenantId, (tx) => getHandoff(tx, handoff.id));
      const active = await withTenant(app.db, tenantId, (tx) => getActiveHandoff(tx, conversation.id));
      if (!fetched || !active) throw new Error("handoff not found");
      rows.push(fetched, active);
      for (const row of rows) {
        expect(row, "a handoff read exposed contactSealed").not.toHaveProperty("contactSealed");
      }
      expect(fetched).toMatchObject({ hasContact: true, status: "claimed" });

      const sealed = await withTenant(app.db, tenantId, (tx) => getHandoffContactSealed(tx, handoff.id));
      expect(sealed?.toString("utf8")).toBe("sealed-contact");
      expect(
        await withTenant(app.db, otherTenantId, (tx) => getHandoffContactSealed(tx, handoff.id)),
      ).toBeNull();
    });

    it("reports a handoff without a contact as hasContact: false and reads no sealed value", async () => {
      const conversation = await withTenant(app.db, tenantId, (tx) =>
        createConversation(tx, tenantId, { botId, visitorId: "ho-7", session: {} }),
      );
      const { handoff } = await withTenant(app.db, tenantId, (tx) =>
        createHandoff(tx, tenantId, { conversationId: conversation.id, reason: "other", summary: "s" }),
      );
      expect(handoff.hasContact).toBe(false);
      expect(await withTenant(app.db, tenantId, (tx) => getHandoffContactSealed(tx, handoff.id))).toBeNull();
    });

    it("records the notification once, so a retried job sends one email", async () => {
      const { handoff } = await newHandoff("ho-5");
      expect(
        await withTenant(app.db, tenantId, (tx) => markHandoffNotified(tx, handoff.id, new Date())),
      ).toBe(true);
      expect(
        await withTenant(app.db, tenantId, (tx) => markHandoffNotified(tx, handoff.id, new Date())),
      ).toBe(false);
    });

    it("lists a tenant's handoffs by status, newest first, and never another tenant's", async () => {
      const tenant = (await createTenant(app.db, { name: "Handoff list" })).tenantId;
      const listBot = await withTenant(app.db, tenant, async (tx) => {
        const store = await createStore(tx, tenant, { platform: "memory", currency: "LKR" });
        return (await createBot(tx, tenant, bot(store.id))).id;
      });
      const ids: string[] = [];
      for (const visitorId of ["l1", "l2", "l3"]) {
        const created = await withTenant(app.db, tenant, async (tx) => {
          const conversation = await createConversation(tx, tenant, {
            botId: listBot,
            visitorId,
            session: {},
          });
          return createHandoff(tx, tenant, {
            conversationId: conversation.id,
            reason: "other",
            summary: visitorId,
          });
        });
        ids.push(created.handoff.id);
      }
      await withTenant(app.db, tenant, (tx) =>
        transitionHandoff(tx, ids[0] ?? "", { to: "claimed", claimedBy: "N" }),
      );
      const open = await withTenant(app.db, tenant, (tx) => listHandoffs(tx, { status: ["open"] }));
      expect(open.map((row) => row.summary)).toEqual(["l3", "l2"]);
      const all = await withTenant(app.db, tenant, (tx) => listHandoffs(tx, {}));
      expect(all).toHaveLength(3);
      expect(await withTenant(app.db, tenant, (tx) => listHandoffs(tx, { limit: 1 }))).toHaveLength(1);
      expect(await withTenant(app.db, otherTenantId, (tx) => listHandoffs(tx, {}))).toEqual([]);
    });
  });

  describe("staff tokens", () => {
    it("finds a token by hash only inside its own tenant context", async () => {
      const token = { name: "front desk", tokenHash: "hash_staff_1", tokenPrefix: "st_1234ab" };
      const created = await withTenant(app.db, tenantId, (tx) => createStaffToken(tx, tenantId, token));
      expect(created).toMatchObject({ name: "front desk", tokenPrefix: "st_1234ab", revokedAt: null });

      expect(await withTenant(app.db, tenantId, (tx) => findStaffToken(tx, token.tokenHash))).toMatchObject({
        id: created.id,
        tenantId,
      });
      expect(await withTenant(app.db, otherTenantId, (tx) => findStaffToken(tx, token.tokenHash))).toBeNull();
      // A transaction without withTenant sets no tenant, so row-level security hides every token.
      expect(await app.db.transaction((tx) => findStaffToken(tx, token.tokenHash))).toBeNull();
      expect(await withTenant(app.db, tenantId, (tx) => findStaffToken(tx, "unknown"))).toBeNull();
    });

    it("stops finding a token once it is revoked, and revokes only once", async () => {
      const created = await withTenant(app.db, tenantId, (tx) =>
        createStaffToken(tx, tenantId, { name: "temp", tokenHash: "hash_staff_2", tokenPrefix: "st_5678cd" }),
      );
      const at = new Date("2027-01-15T10:00:00.000Z");
      expect(await withTenant(app.db, tenantId, (tx) => revokeStaffToken(tx, created.id, at))).toBe(true);
      const listed = await withTenant(app.db, tenantId, (tx) => listStaffTokens(tx));
      expect(listed.find((row) => row.id === created.id)?.revokedAt).toEqual(at);
      expect(await withTenant(app.db, tenantId, (tx) => revokeStaffToken(tx, created.id))).toBe(false);
      expect(await withTenant(app.db, otherTenantId, (tx) => revokeStaffToken(tx, created.id))).toBe(false);
      expect(await withTenant(app.db, tenantId, (tx) => findStaffToken(tx, "hash_staff_2"))).toBeNull();
    });

    it("refuses a duplicate hash and lists tokens without their hash", async () => {
      const tenant = (await createTenant(app.db, { name: "Staff list" })).tenantId;
      const make = (name: string, tokenHash: string) =>
        withTenant(app.db, tenant, (tx) =>
          createStaffToken(tx, tenant, { name, tokenHash, tokenPrefix: "st_abcdef" }),
        );
      await make("desk", "hash_staff_list_1");
      await make("night", "hash_staff_list_2");
      await expect(make("dup", "hash_staff_list_1")).rejects.toThrow();
      const listed = await withTenant(app.db, tenant, (tx) => listStaffTokens(tx));
      expect(listed.map((row) => row.name).sort()).toEqual(["desk", "night"]);
      expect(JSON.stringify(listed)).not.toContain("hash_staff");
      expect(await withTenant(app.db, otherTenantId, (tx) => listStaffTokens(tx))).toEqual([]);
    });
  });

  describe("privacy requests", () => {
    it("tracks a request from pending to a receipt with counts, per tenant", async () => {
      const created = await withTenant(app.db, tenantId, (tx) =>
        createPrivacyRequest(tx, tenantId, { type: "delete", subjectHash: "subject_hmac" }),
      );
      expect(created).toMatchObject({ type: "delete", status: "pending", counts: {}, completedAt: null });
      const finished = await withTenant(app.db, tenantId, (tx) =>
        finishPrivacyRequest(tx, created.id, {
          status: "completed",
          counts: { conversations: 2, messages: 14 },
        }),
      );
      expect(finished).toBe(true);
      expect(await withTenant(app.db, tenantId, (tx) => getPrivacyRequest(tx, created.id))).toMatchObject({
        status: "completed",
        counts: { conversations: 2, messages: 14 },
      });
      const listed = await withTenant(app.db, tenantId, (tx) => listPrivacyRequests(tx, 10));
      expect(listed.map((row) => row.id)).toContain(created.id);
      expect(await withTenant(app.db, otherTenantId, (tx) => getPrivacyRequest(tx, created.id))).toBeNull();
      expect(await withTenant(app.db, otherTenantId, (tx) => listPrivacyRequests(tx, 10))).toEqual([]);
      expect(
        await withTenant(app.db, otherTenantId, (tx) =>
          finishPrivacyRequest(tx, created.id, { status: "failed", counts: {} }),
        ),
      ).toBe(false);
    });

    it("finishes a request only once", async () => {
      const created = await withTenant(app.db, tenantId, (tx) =>
        createPrivacyRequest(tx, tenantId, { type: "export", subjectHash: null }),
      );
      const finish = () =>
        withTenant(app.db, tenantId, (tx) =>
          finishPrivacyRequest(tx, created.id, { status: "completed", counts: {} }),
        );
      expect(await finish()).toBe(true);
      expect(await finish()).toBe(false);
    });
  });
});
