import { randomUUID } from "node:crypto";
import {
  createBot,
  createDb,
  SHOPPER_DATA_TABLES,
  schema,
  type Tx,
  upsertTenantSettings,
  withTenant,
} from "@ace/db";
import { JOBS } from "@ace/db/jobs";
import { createTestDatabase } from "@ace/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { capturingLogger, fakeJob, newStore, testDeps } from "../testing";
import { handleRetentionPurge, purgeTenant } from "./retention";

const testDb = await createTestDatabase();
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date();
const retention = (table: string) => SHOPPER_DATA_TABLES.find((t) => t.table === table)?.retentionDays ?? 0;
/** One day past / one day inside the table's retention. */
const expired = (table: string) => new Date(NOW.getTime() - (retention(table) + 1) * DAY);
const fresh = (table: string) => new Date(NOW.getTime() - (retention(table) - 1) * DAY);
const longAgo = new Date(NOW.getTime() - 400 * DAY);

type Counts = Record<string, number>;

async function tableCounts(tx: Tx): Promise<Counts> {
  const counts: Counts = {};
  const tables = {
    conversations: schema.conversations,
    messages: schema.messages,
    tool_calls: schema.toolCalls,
    turn_traces: schema.turnTraces,
    webhook_events: schema.webhookEvents,
    handoffs: schema.handoffs,
    verifications: schema.verifications,
    consents: schema.consents,
    privacy_exports: schema.privacyExports,
    usage_ledger: schema.usageLedger,
    attributed_orders: schema.attributedOrders,
  };
  for (const [name, table] of Object.entries(tables)) counts[name] = (await tx.select().from(table)).length;
  return counts;
}

describe.skipIf(testDb === null)("retention.purge", () => {
  let app: ReturnType<typeof createDb>;

  beforeAll(() => {
    if (testDb) app = createDb(testDb.appUrl);
  });
  afterAll(async () => {
    await app?.close();
    await testDb?.drop();
  });

  /** Per shopper-data table: one expired and one fresh row. Plus billing rows that are older than everything. */
  async function seedTenant() {
    const { tenantId, storeId } = await newStore(app.db);
    await withTenant(app.db, tenantId, async (tx) => {
      const bot = await createBot(tx, tenantId, {
        storeId,
        persona: {},
        storeFacts: {},
        model: "demo:x",
        cheapModel: "demo:x",
        budgetSoftUsdMicros: 1,
        budgetHardUsdMicros: 2,
      });
      const conversation = (lastMessageAt: Date) => ({
        tenantId,
        botId: bot.id,
        visitorId: "v",
        session: {},
        lastMessageAt,
        // Created long ago: conversations age by their last message, not by creation.
        createdAt: longAgo,
      });
      const [kept] = await tx
        .insert(schema.conversations)
        .values([conversation(fresh("conversations")), conversation(expired("conversations"))])
        .returning({ id: schema.conversations.id });
      const conversationId = kept?.id ?? "";
      await tx.insert(schema.messages).values(
        [expired("messages"), fresh("messages")].map((createdAt, seq) => ({
          tenantId,
          conversationId,
          seq,
          kind: "model",
          payload: {},
          createdAt,
        })),
      );
      await tx.insert(schema.toolCalls).values(
        [expired("tool_calls"), fresh("tool_calls")].map((createdAt) => ({
          tenantId,
          conversationId,
          turnId: "t",
          name: "search_products",
          ok: true,
          ms: 1,
          createdAt,
        })),
      );
      await tx.insert(schema.turnTraces).values(
        [expired("turn_traces"), fresh("turn_traces")].map((createdAt) => ({
          tenantId,
          conversationId,
          turnId: "t",
          model: "demo:x",
          promptVersion: "v",
          inputTokens: 1,
          outputTokens: 1,
          latencyMs: 1,
          toolNames: [],
          outcomes: [],
          regenerated: false,
          ungroundedCount: 0,
          createdAt,
        })),
      );
      await tx.insert(schema.webhookEvents).values(
        [expired("webhook_events"), fresh("webhook_events")].map((receivedAt) => ({
          tenantId,
          storeId,
          eventId: randomUUID(),
          type: "product.updated",
          payload: {},
          receivedAt,
        })),
      );
      // Resolved and consumed rows, so the "one active per conversation" indexes allow two of each.
      await tx.insert(schema.handoffs).values(
        [expired("handoffs"), fresh("handoffs")].map((createdAt) => ({
          tenantId,
          conversationId,
          reason: "asked_for_person",
          summary: "Wants a person",
          status: "resolved",
          resolvedAt: createdAt,
          createdAt,
        })),
      );
      await tx.insert(schema.verifications).values(
        [expired("verifications"), fresh("verifications")].map((createdAt) => ({
          tenantId,
          conversationId,
          channel: "email",
          destinationHash: "d",
          destinationSealed: Buffer.from("sealed"),
          codeHash: "c",
          salt: "s",
          expiresAt: createdAt,
          consumedAt: createdAt,
          createdAt,
        })),
      );
      await tx.insert(schema.consents).values(
        [expired("consents"), fresh("consents")].map((createdAt, i) => ({
          tenantId,
          conversationId,
          noticeVersion: `v${i}`,
          createdAt,
        })),
      );
      const requests = await tx
        .insert(schema.privacyRequests)
        .values([
          { tenantId, type: "export" },
          { tenantId, type: "export" },
        ])
        .returning({ id: schema.privacyRequests.id });
      await tx.insert(schema.privacyExports).values(
        [expired("privacy_exports"), fresh("privacy_exports")].map((createdAt, index) => ({
          tenantId,
          requestId: requests[index]?.id ?? "",
          payload: { conversations: [] },
          expiresAt: new Date(NOW.getTime() + DAY),
          createdAt,
        })),
      );
      await tx.insert(schema.usageLedger).values({
        tenantId,
        storeId,
        kind: "enrich",
        turnId: "job:x",
        model: "demo:x",
        inputTokens: 1,
        outputTokens: 1,
        createdAt: longAgo,
      });
      await tx.insert(schema.attributedOrders).values({
        tenantId,
        storeId,
        orderId: randomUUID(),
        orderNumber: "1",
        conversationId: null,
        totalAmount: 100,
        currency: "LKR",
        placedAt: longAgo,
        createdAt: longAgo,
      });
    });
    return { tenantId, storeId };
  }

  it("deletes expired rows per table and tenant, keeps fresh rows and billing rows", async () => {
    const { tenantId: a } = await seedTenant();
    const { tenantId: b } = await seedTenant();
    const { logger, lines } = capturingLogger();
    const result = (await handleRetentionPurge(
      testDeps(app.db, { logger, now: () => NOW }),
      fakeJob(JOBS.retentionPurge, {}),
    )) as Record<string, Counts>;

    const onePerTable = Object.fromEntries(SHOPPER_DATA_TABLES.map((t) => [t.table, 1]));
    expect(result[a]).toEqual(onePerTable);
    expect(result[b]).toEqual(onePerTable);
    for (const tenantId of [a, b]) {
      expect(await withTenant(app.db, tenantId, tableCounts)).toEqual({
        conversations: 1,
        messages: 1,
        tool_calls: 1,
        turn_traces: 1,
        webhook_events: 1,
        handoffs: 1,
        verifications: 1,
        consents: 1,
        privacy_exports: 1,
        usage_ledger: 1,
        attributed_orders: 1,
      });
    }
    // Counts per table are logged, never content.
    const logged = lines.filter((line) => line.msg === "retention purged");
    expect(logged).toContainEqual(expect.objectContaining({ tenantId: a, table: "messages", deleted: 1 }));
    expect(JSON.stringify(lines)).not.toContain("search_products");
  });

  it("deletes in batches until nothing expired is left", async () => {
    const { tenantId, storeId } = await seedTenant();
    await withTenant(app.db, tenantId, (tx) =>
      tx.insert(schema.webhookEvents).values(
        Array.from({ length: 4 }, () => ({
          tenantId,
          storeId,
          eventId: randomUUID(),
          type: "product.updated",
          payload: {},
          receivedAt: longAgo,
        })),
      ),
    );
    const counts = await purgeTenant(app.db, tenantId, NOW, 2);
    expect(counts.webhook_events).toBe(5);
    expect((await withTenant(app.db, tenantId, tableCounts)).webhook_events).toBe(1);
  });

  it("uses each tenant's clamped retention settings, including OTP hours", async () => {
    const fortyDaysAgo = new Date(NOW.getTime() - 40 * DAY);
    const twoHoursAgo = new Date(NOW.getTime() - 2 * 60 * 60 * 1000);
    const seed = async (custom: boolean) => {
      const { tenantId, storeId } = await newStore(app.db);
      await withTenant(app.db, tenantId, async (tx) => {
        const bot = await createBot(tx, tenantId, {
          storeId,
          persona: {},
          storeFacts: {},
          model: "demo:x",
          cheapModel: "demo:x",
          budgetSoftUsdMicros: 1,
          budgetHardUsdMicros: 2,
        });
        const [conversation] = await tx
          .insert(schema.conversations)
          .values({
            tenantId,
            botId: bot.id,
            visitorId: "retention",
            session: {},
            lastMessageAt: NOW,
            identity: { method: "email_otp", email: "expired@example.com" },
            identityHash: "keep-the-hmac",
            identityExpiresAt: twoHoursAgo,
          })
          .returning();
        if (!conversation) throw new Error("conversation not created");
        await tx.insert(schema.messages).values({
          tenantId,
          conversationId: conversation.id,
          seq: 0,
          kind: "model",
          payload: {},
          createdAt: fortyDaysAgo,
        });
        await tx.insert(schema.verifications).values({
          tenantId,
          conversationId: conversation.id,
          channel: "email",
          destinationHash: "hash",
          destinationSealed: Buffer.from("sealed"),
          codeHash: "code",
          salt: "salt",
          expiresAt: NOW,
          consumedAt: twoHoursAgo,
          createdAt: twoHoursAgo,
        });
        if (custom) {
          await upsertTenantSettings(tx, tenantId, {
            retention: { messagesDays: 30, otpHours: 1 },
          });
        }
      });
      return tenantId;
    };
    const a = await seed(true);
    const b = await seed(false);

    await purgeTenant(app.db, a, NOW);
    await purgeTenant(app.db, b, NOW);

    const remaining = (tenantId: string) =>
      withTenant(app.db, tenantId, async (tx) => ({
        messages: (await tx.select().from(schema.messages)).length,
        verifications: (await tx.select().from(schema.verifications)).length,
        conversation: (await tx.select().from(schema.conversations))[0],
      }));
    const remainingA = await remaining(a);
    const remainingB = await remaining(b);
    expect(remainingA).toMatchObject({ messages: 0, verifications: 0 });
    expect(remainingB).toMatchObject({ messages: 1, verifications: 1 });
    for (const result of [remainingA, remainingB]) {
      expect(result.conversation?.identity).toBeNull();
      expect(result.conversation?.identityExpiresAt).toBeNull();
      expect(result.conversation?.identityHash).toBe("keep-the-hmac");
    }
  });
  it("keeps purging the other tenants when one tenant's pass fails, then fails the job", async () => {
    const { tenantId: a } = await seedTenant();
    const { tenantId: b } = await seedTenant();
    const { logger, lines } = capturingLogger();
    const failingForA: typeof purgeTenant = async (db, tenantId, now) => {
      if (tenantId === a) throw new TypeError("boom with private detail");
      return purgeTenant(db, tenantId, now);
    };
    await expect(
      handleRetentionPurge(
        testDeps(app.db, { logger, now: () => NOW }),
        fakeJob(JOBS.retentionPurge, {}),
        failingForA,
      ),
    ).rejects.toThrow(/1 tenant/);

    // B was purged after A failed; A kept its expired rows.
    expect((await withTenant(app.db, b, tableCounts)).webhook_events).toBe(1);
    expect((await withTenant(app.db, a, tableCounts)).webhook_events).toBe(2);
    const failure = lines.find((line) => line.msg === "retention purge failed for tenant");
    expect(failure).toMatchObject({ tenantId: a, error: "TypeError" });
    expect(JSON.stringify(lines)).not.toContain("private detail");
  });
});
