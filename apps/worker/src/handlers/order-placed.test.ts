import { randomUUID } from "node:crypto";
import {
  attributionReport,
  createBot,
  createConversation,
  createDb,
  recordWebhookEvent,
  schema,
  withTenant,
} from "@ace/db";
import { JOBS } from "@ace/db/jobs";
import { createTestDatabase } from "@ace/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fakeJob, newStore, testDeps } from "../testing";
import { handleOrderPlaced } from "./order-placed";

const testDb = await createTestDatabase();
const RANGE = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z") };

describe.skipIf(testDb === null)("order.placed attribution", () => {
  let app: ReturnType<typeof createDb>;

  beforeAll(() => {
    if (testDb) app = createDb(testDb.appUrl);
  });
  afterAll(async () => {
    await app?.close();
    await testDb?.drop();
  });

  /** A tenant with one store, bot and conversation. */
  async function shop() {
    const { tenantId, storeId } = await newStore(app.db);
    const conversationId = await withTenant(app.db, tenantId, async (tx) => {
      const bot = await createBot(tx, tenantId, {
        storeId,
        persona: {},
        storeFacts: {},
        model: "demo:x",
        cheapModel: "demo:x",
        budgetSoftUsdMicros: 1,
        budgetHardUsdMicros: 2,
      });
      return (await createConversation(tx, tenantId, { botId: bot.id, visitorId: "v1", session: {} })).id;
    });
    return { tenantId, storeId, conversationId };
  }

  async function placeOrder(
    s: { tenantId: string; storeId: string },
    order: { amount: number; currency?: string; conversationId?: string; orderId?: string },
  ) {
    const eventId = `order.placed:${order.orderId ?? randomUUID()}`;
    const payload = {
      eventId,
      type: "order.placed",
      orderId: order.orderId ?? randomUUID(),
      orderNumber: "1001",
      total: { amount: order.amount, currency: order.currency ?? "LKR" },
      placedAt: "2026-10-09T10:00:00.000Z",
      attributes: order.conversationId ? { ace_conversation_id: order.conversationId } : {},
    };
    await withTenant(app.db, s.tenantId, (tx) =>
      recordWebhookEvent(tx, s.tenantId, { storeId: s.storeId, eventId, type: "order.placed", payload }),
    );
    return { ...fakeJob(JOBS.orderPlaced, { tenantId: s.tenantId, storeId: s.storeId, eventId }), eventId };
  }

  const report = (tenantId: string) => withTenant(app.db, tenantId, (tx) => attributionReport(tx, RANGE));
  const rows = (tenantId: string) =>
    withTenant(app.db, tenantId, (tx) => tx.select().from(schema.attributedOrders));

  it("attributes an order to this tenant's conversation and sums its revenue", async () => {
    const s = await shop();
    const deps = testDeps(app.db);
    const job = await placeOrder(s, { amount: 1_250_000, conversationId: s.conversationId });
    await handleOrderPlaced(deps, job);
    await handleOrderPlaced(deps, await placeOrder(s, { amount: 500_000 }));

    expect(await report(s.tenantId)).toEqual({
      orders: 2,
      chatAssisted: 1,
      revenue: [{ currency: "LKR", total: 1_750_000, chatAssisted: 1_250_000 }],
    });
    const [event] = await withTenant(app.db, s.tenantId, (tx) =>
      tx.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.eventId, job.eventId)),
    );
    expect(event?.processedAt).toBeInstanceOf(Date);
  });

  it("stores another tenant's conversation id as null", async () => {
    const a = await shop();
    const b = await shop();
    await handleOrderPlaced(
      testDeps(app.db),
      await placeOrder(a, { amount: 900, conversationId: b.conversationId }),
    );
    const stored = await rows(a.tenantId);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.conversationId).toBeNull();
    expect((await report(a.tenantId)).chatAssisted).toBe(0);
  });

  it("stores a malformed conversation id as null", async () => {
    const s = await shop();
    await handleOrderPlaced(
      testDeps(app.db),
      await placeOrder(s, { amount: 900, conversationId: "not-a-uuid" }),
    );
    expect((await rows(s.tenantId))[0]?.conversationId).toBeNull();
  });

  it("keeps one row when the same event is processed twice", async () => {
    const s = await shop();
    const job = await placeOrder(s, { amount: 700, conversationId: s.conversationId, orderId: "order-1" });
    await handleOrderPlaced(testDeps(app.db), job);
    await handleOrderPlaced(testDeps(app.db), job);
    expect(await rows(s.tenantId)).toHaveLength(1);
    expect((await report(s.tenantId)).orders).toBe(1);
  });

  it("reports each currency separately and never adds across them", async () => {
    const s = await shop();
    const deps = testDeps(app.db);
    await handleOrderPlaced(deps, await placeOrder(s, { amount: 1_000, conversationId: s.conversationId }));
    await handleOrderPlaced(deps, await placeOrder(s, { amount: 25, currency: "USD" }));
    const result = await report(s.tenantId);
    expect(result.revenue).toEqual([
      { currency: "LKR", total: 1_000, chatAssisted: 1_000 },
      { currency: "USD", total: 25, chatAssisted: 0 },
    ]);
  });

  it("excludes orders outside the range", async () => {
    const s = await shop();
    await handleOrderPlaced(testDeps(app.db), await placeOrder(s, { amount: 1_000 }));
    const september = { from: new Date("2026-09-01T00:00:00Z"), to: new Date("2026-10-01T00:00:00Z") };
    expect(await withTenant(app.db, s.tenantId, (tx) => attributionReport(tx, september))).toEqual({
      orders: 0,
      chatAssisted: 0,
      revenue: [],
    });
  });

  it("completes without a row when the webhook event is gone", async () => {
    const s = await shop();
    const job = fakeJob(JOBS.orderPlaced, { tenantId: s.tenantId, storeId: s.storeId, eventId: "missing" });
    await expect(handleOrderPlaced(testDeps(app.db), job)).resolves.not.toThrow();
    expect(await rows(s.tenantId)).toHaveLength(0);
  });
});
