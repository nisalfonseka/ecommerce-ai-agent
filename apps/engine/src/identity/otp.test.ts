import { randomUUID } from "node:crypto";
import {
  createConversation,
  createDb,
  createStore,
  createTenant,
  schema,
  upsertTenantSettings,
  withTenant,
} from "@ace/db";
import { createTestDatabase } from "@ace/db/testing";
import { type Notifier, NotifyError } from "@ace/notify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { currentIdentity } from "./conversation-identity";
import { confirmVerification, type OtpDeps, startVerification } from "./otp";

const testDb = await createTestDatabase();

describe.skipIf(testDb === null)("one-time-code verification", () => {
  let db: ReturnType<typeof createDb>;
  let tenantId: string;
  let conversationId: string;
  let now: Date;
  let sms: { to: string; text: string }[];
  let email: { to: string; subject: string; text: string }[];
  let deps: OtpDeps;

  beforeAll(async () => {
    if (!testDb) return;
    db = createDb(testDb.appUrl);
  });

  beforeEach(async () => {
    now = new Date();
    sms = [];
    email = [];
    ({ tenantId } = await createTenant(db.db, { name: `OTP-${randomUUID()}` }));
    conversationId = await withTenant(db.db, tenantId, async (tx) => {
      const store = await createStore(tx, tenantId, { platform: "memory", currency: "LKR" });
      const [bot] = await tx
        .insert(schema.bots)
        .values({
          tenantId,
          storeId: store.id,
          persona: {},
          storeFacts: {},
          model: "test:model",
          cheapModel: "test:model",
          budgetSoftUsdMicros: 1,
          budgetHardUsdMicros: 2,
        })
        .returning();
      if (!bot) throw new Error("bot missing");
      return (
        await createConversation(tx, tenantId, { botId: bot.id, visitorId: "visitor-123", session: {} })
      ).id;
    });
    const notifier: Notifier = {
      sendSms: async (input) => {
        sms.push(input);
        return { providerId: "sms-1" };
      },
      sendEmail: async (input) => {
        email.push(input);
        return { providerId: "email-1" };
      },
    };
    deps = {
      db: db.db,
      notifier,
      masterKey: Buffer.alloc(32, 3),
      now: () => now,
      random: (n) => Buffer.alloc(n),
      ipLimiter: { check: () => ({ ok: true }) },
    };
  });

  afterAll(async () => {
    await db?.close();
    await testDb?.drop();
  });

  const ctx = () => ({ tenantId, conversationId, ip: "203.0.113.10" });

  it("verifies SMS once and stores a 30-minute conversation identity", async () => {
    const recorded: { tenantId: string; conversationId: string; channel: string; text: string }[] = [];
    deps.outbox = { record: (entry) => recorded.push(entry) };
    expect(await startVerification(deps, ctx(), { channel: "sms", destination: "077 123 4567" })).toEqual({
      ok: true,
      maskedDestination: "+94*****4567",
      expiresInSeconds: 600,
    });
    expect(sms).toHaveLength(1);
    expect(sms[0]?.to).toBe("+94771234567");
    expect(recorded).toEqual([expect.objectContaining({ tenantId, conversationId, channel: "sms" })]);
    const code = /\b\d{6}\b/.exec(sms[0]?.text ?? "")?.[0];
    expect(code).toBe("000000");
    expect(await confirmVerification(deps, ctx(), { code: code ?? "" })).toEqual({
      ok: true,
      identity: {
        method: "phone_otp",
        phone: "+94771234567",
        verifiedAt: now.toISOString(),
      },
    });
    expect(await confirmVerification(deps, ctx(), { code: code ?? "" })).toEqual({
      ok: false,
      reason: "no_pending",
    });
    const stored = await withTenant(db.db, tenantId, async (tx) => {
      const [row] = await tx
        .select()
        .from(schema.conversations)
        .where(eq(schema.conversations.id, conversationId));
      return row;
    });
    expect(
      currentIdentity(stored ?? { identity: null }, new Date(now.getTime() + 29 * 60_000)),
    ).toMatchObject({
      phone: "+94771234567",
    });
    expect(
      currentIdentity(stored ?? { identity: null }, new Date(now.getTime() + 30 * 60_000 + 1)),
    ).toBeNull();
  });

  it("normalizes email and stores only the identity proven by that channel", async () => {
    await startVerification(deps, ctx(), { channel: "email", destination: " Shopper@Example.COM " });
    expect(email[0]?.to).toBe("shopper@example.com");
    const code = /\b\d{6}\b/.exec(email[0]?.text ?? "")?.[0] ?? "";
    const result = await confirmVerification(deps, ctx(), { code });
    expect(result).toEqual({
      ok: true,
      identity: { method: "email_otp", email: "shopper@example.com", verifiedAt: now.toISOString() },
    });
    expect(JSON.stringify(result)).not.toContain("phone");
  });

  it("locks on the sixth wrong attempt and refuses the right code afterwards", async () => {
    await startVerification(deps, ctx(), { channel: "sms", destination: "0771234567" });
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      expect(await confirmVerification(deps, ctx(), { code: "999999" })).toEqual({
        ok: false,
        reason: "invalid_code",
      });
    }
    expect(await confirmVerification(deps, ctx(), { code: "999999" })).toEqual({
      ok: false,
      reason: "locked",
    });
    expect(await confirmVerification(deps, ctx(), { code: "000000" })).toEqual({
      ok: false,
      reason: "locked",
    });
  });

  it("distinguishes an expired code without accepting it", async () => {
    await startVerification(deps, ctx(), { channel: "email", destination: "a@example.com" });
    now = new Date(now.getTime() + 10 * 60_000 + 1);
    expect(await confirmVerification(deps, ctx(), { code: "000000" })).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("treats wrong codes of equal and different lengths the same", async () => {
    await startVerification(deps, ctx(), { channel: "email", destination: "a@example.com" });
    expect(await confirmVerification(deps, ctx(), { code: "999999" })).toEqual({
      ok: false,
      reason: "invalid_code",
    });
    expect(await confirmVerification(deps, ctx(), { code: "9" })).toEqual({
      ok: false,
      reason: "invalid_code",
    });
  });

  it("enforces destination, conversation and IP send limits before sending", async () => {
    for (let i = 0; i < 3; i += 1) {
      expect(
        (await startVerification(deps, ctx(), { channel: "email", destination: "same@example.com" })).ok,
      ).toBe(true);
    }
    expect(
      await startVerification(deps, ctx(), { channel: "email", destination: "same@example.com" }),
    ).toEqual({
      ok: false,
      reason: "rate_limited",
      retryAfterSeconds: 3600,
    });

    for (let i = 0; i < 2; i += 1) {
      expect(
        (await startVerification(deps, ctx(), { channel: "email", destination: `other-${i}@example.com` }))
          .ok,
      ).toBe(true);
    }
    expect(
      await startVerification(deps, ctx(), { channel: "email", destination: "sixth@example.com" }),
    ).toMatchObject({
      ok: false,
      reason: "rate_limited",
    });

    let hits = 0;
    const ipDeps: OtpDeps = {
      ...deps,
      ipLimiter: { check: () => (++hits > 20 ? { ok: false, retryAfterS: 120 } : { ok: true }) },
    };
    for (let i = 0; i < 20; i += 1) {
      const fresh = await newConversation();
      expect(
        (
          await startVerification(
            ipDeps,
            { tenantId, conversationId: fresh, ip: "198.51.100.1" },
            {
              channel: "email",
              destination: `ip-${i}@example.com`,
            },
          )
        ).ok,
      ).toBe(true);
    }
    const fresh = await newConversation();
    expect(
      await startVerification(
        ipDeps,
        { tenantId, conversationId: fresh, ip: "198.51.100.1" },
        {
          channel: "email",
          destination: "ip-last@example.com",
        },
      ),
    ).toEqual({ ok: false, reason: "rate_limited", retryAfterSeconds: 120 });
  });

  async function newConversation(): Promise<string> {
    return withTenant(db.db, tenantId, async (tx) => {
      const [bot] = await tx.select().from(schema.bots).limit(1);
      if (!bot) throw new Error("bot missing");
      return (
        await createConversation(tx, tenantId, { botId: bot.id, visitorId: "visitor-new", session: {} })
      ).id;
    });
  }

  it("rejects disabled or disallowed destinations without sending", async () => {
    expect(await startVerification(deps, ctx(), { channel: "sms", destination: "+14155552671" })).toEqual({
      ok: false,
      reason: "invalid_destination",
    });
    expect(sms).toHaveLength(0);
    await withTenant(db.db, tenantId, (tx) =>
      upsertTenantSettings(tx, tenantId, { otp: { channels: ["email"] } }),
    );
    expect(await startVerification(deps, ctx(), { channel: "sms", destination: "0771234567" })).toEqual({
      ok: false,
      reason: "channel_disabled",
    });
    expect(sms).toHaveLength(0);
  });

  it("does identical work whether or not a masked destination could own an order", async () => {
    const otherConversation = await newConversation();
    const knownShape = await startVerification(deps, ctx(), {
      channel: "sms",
      destination: "+94771234567",
    });
    const unknownShape = await startVerification(
      deps,
      { tenantId, conversationId: otherConversation, ip: "203.0.113.11" },
      { channel: "sms", destination: "+94779994567" },
    );
    expect(unknownShape).toEqual(knownShape);
    const counts = await withTenant(db.db, tenantId, async (tx) => {
      const rows = await tx
        .select({ conversationId: schema.verifications.conversationId })
        .from(schema.verifications);
      return [conversationId, otherConversation].map(
        (id) => rows.filter((row) => row.conversationId === id).length,
      );
    });
    expect(counts).toEqual([1, 1]);
  });

  it("invalidates the first destination when a second code is started", async () => {
    let value = 0;
    deps.random = (n) => Buffer.alloc(n, value++);
    await startVerification(deps, ctx(), { channel: "email", destination: "a@example.com" });
    const first = /\b\d{6}\b/.exec(email[0]?.text ?? "")?.[0] ?? "";
    await startVerification(deps, ctx(), { channel: "email", destination: "b@example.com" });
    expect(await confirmVerification(deps, ctx(), { code: first })).toEqual({
      ok: false,
      reason: "invalid_code",
    });
  });

  it("rolls back the pending row when delivery fails", async () => {
    deps.notifier = {
      ...deps.notifier,
      sendSms: async () => {
        throw new NotifyError("unavailable", "SMS provider is unavailable.");
      },
    };
    expect(await startVerification(deps, ctx(), { channel: "sms", destination: "0771234567" })).toEqual({
      ok: false,
      reason: "unavailable",
    });
    const count = await withTenant(db.db, tenantId, async (tx) => {
      const rows = await tx
        .select()
        .from(schema.verifications)
        .where(eq(schema.verifications.conversationId, conversationId));
      return rows.length;
    });
    expect(count).toBe(0);
  });
});
