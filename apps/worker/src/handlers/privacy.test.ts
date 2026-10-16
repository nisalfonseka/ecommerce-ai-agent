import { randomUUID } from "node:crypto";
import {
  createBot,
  createDb,
  createPrivacyRequest,
  getPrivacyRequest,
  SHOPPER_DATA_TABLES,
  schema,
  type Tx,
  takePrivacyExport,
  withTenant,
} from "@ace/db";
import { JOBS } from "@ace/db/jobs";
import { createTestDatabase } from "@ace/db/testing";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { capturingLogger, fakeJob, newStore, testDeps } from "../testing";
import { handleHandoffNotify } from "./handoff-notify";
import { handleShopperDelete, handleTenantOffboard } from "./shopper-delete";
import { handleShopperExport } from "./shopper-export";

const testDb = await createTestDatabase();
const NOW = new Date("2026-10-16T04:00:00.000Z");

async function seedConversation(
  tx: Tx,
  input: { tenantId: string; botId: string; visitorId: string; identityHash: string; contact: string },
) {
  const [conversation] = await tx
    .insert(schema.conversations)
    .values({
      tenantId: input.tenantId,
      botId: input.botId,
      visitorId: input.visitorId,
      session: {},
      identity: { method: "email_otp", email: input.contact },
      identityHash: input.identityHash,
      identityExpiresAt: new Date(NOW.getTime() + 60_000),
    })
    .returning();
  if (!conversation) throw new Error("conversation not created");
  await tx.insert(schema.messages).values({
    tenantId: input.tenantId,
    conversationId: conversation.id,
    seq: 0,
    kind: "model",
    payload: { role: "user", content: `private model payload ${input.contact}` },
    display: { role: "user", text: `display ${input.identityHash}` },
  });
  await tx.insert(schema.toolCalls).values({
    tenantId: input.tenantId,
    conversationId: conversation.id,
    turnId: randomUUID(),
    name: "lookup_order",
    inputRedacted: { secret: `tool-${input.contact}` },
    ok: true,
    ms: 1,
  });
  await tx.insert(schema.turnTraces).values({
    tenantId: input.tenantId,
    conversationId: conversation.id,
    turnId: randomUUID(),
    model: "demo:x",
    promptVersion: "v1",
    inputTokens: 1,
    outputTokens: 1,
    latencyMs: 1,
    toolNames: ["lookup_order"],
    outcomes: [],
    regenerated: false,
    ungroundedCount: 0,
    error: `trace-${input.contact}`,
  });
  await tx.insert(schema.handoffs).values({
    tenantId: input.tenantId,
    conversationId: conversation.id,
    reason: "asked_for_person",
    summary: `summary ${input.identityHash}`,
    contactSealed: Buffer.from(`sealed-${input.contact}`),
    status: "resolved",
    resolvedAt: NOW,
  });
  await tx.insert(schema.consents).values({
    tenantId: input.tenantId,
    conversationId: conversation.id,
    noticeVersion: "v1",
  });
  await tx.insert(schema.verifications).values({
    tenantId: input.tenantId,
    conversationId: conversation.id,
    channel: "email",
    destinationHash: input.identityHash,
    destinationSealed: Buffer.from("sealed-private-contact"),
    codeHash: "code",
    salt: "salt",
    expiresAt: new Date(NOW.getTime() + 60_000),
    consumedAt: NOW,
  });
  return conversation.id;
}

describe.skipIf(testDb === null)("privacy jobs", () => {
  let pool: ReturnType<typeof createDb>;

  beforeAll(() => {
    if (testDb) pool = createDb(testDb.appUrl);
  });
  afterAll(async () => {
    await pool?.close();
    await testDb?.drop();
  });

  async function seedSubjectSet(prefix: string) {
    const { tenantId, storeId } = await newStore(pool.db);
    return withTenant(pool.db, tenantId, async (tx) => {
      const bot = await createBot(tx, tenantId, {
        storeId,
        persona: {},
        storeFacts: {},
        model: "demo:x",
        cheapModel: "demo:x",
        budgetSoftUsdMicros: 1,
        budgetHardUsdMicros: 2,
      });
      const visitorId = `shared-${prefix}`;
      const email = await seedConversation(tx, {
        tenantId,
        botId: bot.id,
        visitorId,
        identityHash: `${prefix}-email-hash`,
        contact: `${prefix}@example.com`,
      });
      const phone = await seedConversation(tx, {
        tenantId,
        botId: bot.id,
        visitorId,
        identityHash: `${prefix}-phone-hash`,
        contact: "+94770000001",
      });
      const other = await seedConversation(tx, {
        tenantId,
        botId: bot.id,
        visitorId,
        identityHash: `${prefix}-other-hash`,
        contact: `other-${prefix}@example.com`,
      });
      await tx.insert(schema.attributedOrders).values({
        tenantId,
        storeId,
        orderId: randomUUID(),
        orderNumber: prefix,
        conversationId: email,
        totalAmount: 1000,
        currency: "LKR",
        placedAt: NOW,
      });
      await tx.insert(schema.webhookEvents).values({
        tenantId,
        storeId,
        eventId: randomUUID(),
        type: "product.updated",
        payload: { product: "merchant event" },
      });
      return {
        tenantId,
        storeId,
        email,
        phone,
        other,
        emailHash: `${prefix}-email-hash`,
        phoneHash: `${prefix}-phone-hash`,
      };
    });
  }

  it("exports only display data for the selected subject, once, with a 24-hour expiry", async () => {
    const seeded = await seedSubjectSet("export");
    const request = await withTenant(pool.db, seeded.tenantId, (tx) =>
      createPrivacyRequest(tx, seeded.tenantId, { type: "export", subjectHash: seeded.emailHash }),
    );
    const { logger, lines } = capturingLogger();
    const deps = testDeps(pool.db, { logger, now: () => NOW });
    const counts = await handleShopperExport(
      deps,
      fakeJob(JOBS.shopperExport, {
        tenantId: seeded.tenantId,
        requestId: request.id,
        subjectHash: seeded.emailHash,
      }),
    );
    expect(counts).toMatchObject({
      conversations: 1,
      messages: 1,
      handoffs: 1,
      consents: 1,
      verifications: 1,
    });
    const bundle = await withTenant(pool.db, seeded.tenantId, (tx) => takePrivacyExport(tx, request.id, NOW));
    const serialized = JSON.stringify(bundle);
    expect(serialized).toContain(`display ${seeded.emailHash}`);
    expect(serialized).not.toContain("other-export@example.com");
    expect(serialized).not.toContain("tool-export@example.com");
    expect(serialized).not.toContain("trace-export@example.com");
    expect(serialized).not.toContain("tool_calls");
    expect(serialized).not.toContain("turn_traces");
    expect(
      await withTenant(pool.db, seeded.tenantId, (tx) => takePrivacyExport(tx, request.id, NOW)),
    ).toBeNull();
    expect(JSON.stringify(lines)).not.toContain("export@example.com");

    const expiredRequest = await withTenant(pool.db, seeded.tenantId, (tx) =>
      createPrivacyRequest(tx, seeded.tenantId, { type: "export", subjectHash: seeded.emailHash }),
    );
    await handleShopperExport(
      deps,
      fakeJob(JOBS.shopperExport, {
        tenantId: seeded.tenantId,
        requestId: expiredRequest.id,
        subjectHash: seeded.emailHash,
      }),
    );
    const afterExpiry = new Date(NOW.getTime() + 24 * 60 * 60 * 1000 + 1);
    expect(
      await withTenant(pool.db, seeded.tenantId, (tx) =>
        takePrivacyExport(tx, expiredRequest.id, afterExpiry),
      ),
    ).toBeNull();
  });

  it("deletes email and phone subjects independently, keeps billing facts, and repeats with zero counts", async () => {
    const seeded = await seedSubjectSet("delete");
    const [pendingHandoff] = await withTenant(pool.db, seeded.tenantId, (tx) =>
      tx
        .select({ id: schema.handoffs.id })
        .from(schema.handoffs)
        .where(eq(schema.handoffs.conversationId, seeded.email)),
    );
    if (!pendingHandoff) throw new Error("handoff not seeded");
    const priorExport = await withTenant(pool.db, seeded.tenantId, (tx) =>
      createPrivacyRequest(tx, seeded.tenantId, { type: "export", subjectHash: null }),
    );
    await handleShopperExport(
      testDeps(pool.db, { now: () => NOW }),
      fakeJob(JOBS.shopperExport, {
        tenantId: seeded.tenantId,
        requestId: priorExport.id,
        conversationId: seeded.email,
      }),
    );
    const remove = async (subjectHash: string) => {
      const request = await withTenant(pool.db, seeded.tenantId, (tx) =>
        createPrivacyRequest(tx, seeded.tenantId, { type: "delete", subjectHash }),
      );
      return handleShopperDelete(
        testDeps(pool.db, { now: () => NOW }),
        fakeJob(JOBS.shopperDelete, { tenantId: seeded.tenantId, requestId: request.id, subjectHash }),
      );
    };
    expect(await remove(seeded.emailHash)).toMatchObject({
      conversations: 1,
      messages: 1,
      tool_calls: 1,
      turn_traces: 1,
      privacy_exports: 1,
    });
    await expect(
      handleHandoffNotify(
        testDeps(pool.db),
        fakeJob(JOBS.handoffNotify, { tenantId: seeded.tenantId, handoffId: pendingHandoff.id }),
      ),
    ).resolves.toBeUndefined();
    expect(await remove(seeded.emailHash)).toMatchObject({
      conversations: 0,
      messages: 0,
      tool_calls: 0,
      turn_traces: 0,
    });
    let ids = await withTenant(pool.db, seeded.tenantId, (tx) =>
      tx.select({ id: schema.conversations.id }).from(schema.conversations),
    );
    expect(ids.map((row) => row.id).sort()).toEqual([seeded.other, seeded.phone].sort());
    expect(await remove(seeded.phoneHash)).toMatchObject({ conversations: 1 });
    ids = await withTenant(pool.db, seeded.tenantId, (tx) =>
      tx.select({ id: schema.conversations.id }).from(schema.conversations),
    );
    expect(ids).toEqual([{ id: seeded.other }]);
    const [billing] = await withTenant(pool.db, seeded.tenantId, (tx) =>
      tx.select().from(schema.attributedOrders),
    );
    expect(billing?.conversationId).toBeNull();
  });

  it("offboards every shopper-data table for one tenant and leaves another tenant and billing facts intact", async () => {
    const a = await seedSubjectSet("offboard-a");
    const b = await seedSubjectSet("offboard-b");
    const request = await withTenant(pool.db, a.tenantId, (tx) =>
      createPrivacyRequest(tx, a.tenantId, { type: "offboard", subjectHash: null }),
    );
    const counts = await handleTenantOffboard(
      testDeps(pool.db, { now: () => NOW }),
      fakeJob(JOBS.tenantOffboard, { tenantId: a.tenantId, requestId: request.id }),
    );
    expect(counts?.conversations).toBe(3);
    for (const { table } of SHOPPER_DATA_TABLES) {
      const remainingA = await withTenant(pool.db, a.tenantId, (tx) =>
        tx.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)}`),
      );
      expect(remainingA.rows[0]?.n, table).toBe(0);
    }
    expect(
      await withTenant(pool.db, a.tenantId, (tx) => tx.select().from(schema.attributedOrders)),
    ).toHaveLength(1);
    expect(
      await withTenant(pool.db, b.tenantId, (tx) => tx.select().from(schema.conversations)),
    ).toHaveLength(3);
    const receipt = await withTenant(pool.db, a.tenantId, (tx) => getPrivacyRequest(tx, request.id));
    expect(receipt).toMatchObject({
      status: "completed",
      counts: expect.objectContaining({ conversations: 3 }),
    });
  });
});
