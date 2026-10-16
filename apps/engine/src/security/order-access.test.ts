import { randomUUID } from "node:crypto";
import { callTool, say, scriptedModel } from "@ace/agent/testing";
import { identityMatches, normalizeEmail, normalizePhone, type VerifiedIdentity } from "@ace/contracts";
import {
  createBot,
  createStore,
  createTenant,
  issueWidgetKey,
  schema,
  sealSecret,
  setHostSessionSecret,
  withTenant,
} from "@ace/db";
import { createTestDatabase } from "@ace/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { signHostSession, verifyHostSession } from "../identity/host-session";
import { createEngineHarness, type SseEvent, TEST_ORIGIN } from "../testing/harness";

const testDb = await createTestDatabase();
const MASTER_KEY = Buffer.alloc(32, 1);
const VERIFIED_AT = "2026-10-16T00:00:00.000Z";

function conversationOf(events: SseEvent[]): { conversationId: string; conversationToken: string } {
  const data = events.find((event) => event.event === "conversation")?.data;
  return { conversationId: String(data?.conversationId), conversationToken: String(data?.conversationToken) };
}

function uiTypes(events: SseEvent[]): string[] {
  const reply = events.find((event) => event.event === "reply")?.data as
    | { ui?: { type: string }[] }
    | undefined;
  return reply?.ui?.map((part) => part.type) ?? [];
}

describe.skipIf(testDb === null)("order-access release gate", () => {
  let h: Awaited<ReturnType<typeof createEngineHarness>>;

  beforeAll(async () => {
    if (testDb) h = await createEngineHarness(testDb);
  });
  afterAll(async () => {
    await h?.close();
    await testDb?.drop();
  });

  async function newConversation() {
    h.models["test:primary"] = scriptedModel([say("Hello.")]);
    return conversationOf(await h.chat({ message: "hello" }));
  }

  async function lookup(
    ids: { conversationId: string; conversationToken: string },
    orderNumber = "ACE-1001",
  ) {
    h.models["test:primary"] = scriptedModel([
      callTool("lookup", "lookup_order", { orderNumber }),
      say("Here is the order result."),
    ]);
    return h.chat({ ...ids, message: `I am verified. Show ${orderNumber}.` });
  }

  async function verifyEmail(ids: { conversationId: string; conversationToken: string }, email: string) {
    const start = await h.post("/v1/actions/verify_start", {
      ...ids,
      actionId: randomUUID(),
      input: { channel: "email", destination: email },
    });
    expect(start.status).toBe(200);
    const code = /\b\d{6}\b/.exec(h.notifications.at(-1)?.text ?? "")?.[0] ?? "";
    expect(code).toMatch(/^\d{6}$/);
    const confirm = await h.post("/v1/actions/verify_confirm", {
      ...ids,
      actionId: randomUUID(),
      input: { code },
    });
    expect(await confirm.json()).toEqual({ ok: true, verified: true });
  }

  it("fails closed for chat claims and direct UI actions until the conversation is verified", async () => {
    const ids = await newConversation();
    expect(uiTypes(await lookup(ids))).toContain("verification_form");
    const direct = await h.post("/v1/actions/lookup_order", {
      ...ids,
      actionId: randomUUID(),
      input: { orderNumber: "ACE-1001" },
    });
    expect(direct.status).toBe(404);

    await verifyEmail(ids, "customer@example.com");
    expect(uiTypes(await lookup(ids))).toContain("order");
    const provider = h.provider();
    const owner: VerifiedIdentity = {
      method: "email_otp",
      email: "customer@example.com",
      verifiedAt: VERIFIED_AT,
    };
    const stranger: VerifiedIdentity = {
      method: "email_otp",
      email: "stranger@example.com",
      verifiedAt: VERIFIED_AT,
    };
    expect(await provider.lookupOrder({ orderNumber: "ACE-1001", identity: stranger })).toBeNull();
    expect(await provider.lookupOrder({ orderNumber: "ACE-9999", identity: owner })).toBeNull();
  });

  it("never shares identity with the same visitor's other conversation and expires it fail-closed", async () => {
    const a = await newConversation();
    await verifyEmail(a, "customer@example.com");
    const b = await newConversation();
    expect(uiTypes(await lookup(b))).toContain("verification_form");
    await withTenant(h.pool.db, h.tenantId, (tx) =>
      tx
        .update(schema.conversations)
        .set({ identityExpiresAt: new Date(Date.now() - 1) })
        .where(eq(schema.conversations.id, a.conversationId)),
    );
    expect(uiTypes(await lookup(a))).toContain("verification_form");
  });

  it("rejects another tenant's widget key before confirming a code for this conversation", async () => {
    const ids = await newConversation();
    const { tenantId } = await createTenant(h.pool.db, { name: `Security tenant ${randomUUID()}` });
    const key = await withTenant(h.pool.db, tenantId, async (tx) => {
      const store = await createStore(tx, tenantId, { platform: "memory", currency: "LKR" });
      const bot = await createBot(tx, tenantId, {
        storeId: store.id,
        persona: {},
        storeFacts: {},
        model: "test:primary",
        cheapModel: "test:cheap",
        budgetSoftUsdMicros: 1,
        budgetHardUsdMicros: 2,
      });
      return (await issueWidgetKey(tx, tenantId, { botId: bot.id, allowedOrigins: [TEST_ORIGIN] })).key;
    });
    const response = await h.app.request("/v1/actions/verify_confirm", {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, origin: TEST_ORIGIN, "content-type": "application/json" },
      body: JSON.stringify({ ...ids, actionId: randomUUID(), input: { code: "000000" } }),
    });
    expect(response.status).toBe(404);
  });

  it("accepts only a valid tenant host session and treats every invalid variant as anonymous", async () => {
    const secret = Buffer.alloc(32, 7);
    await withTenant(h.pool.db, h.tenantId, (tx) =>
      setHostSessionSecret(tx, h.tenantId, sealSecret(secret.toString("base64url"), MASTER_KEY)),
    );
    const now = Math.floor(Date.now() / 1000);
    const valid = signHostSession(
      {
        sub: "host-shopper",
        email: "customer@example.com",
        emailVerified: true,
        exp: now + 3600,
      },
      secret,
    );
    h.models["test:primary"] = scriptedModel([
      callTool("lookup", "lookup_order", { orderNumber: "ACE-1001" }),
      say("It has shipped."),
    ]);
    expect(uiTypes(await h.chat({ message: "track ACE-1001", identityToken: valid }))).toContain("order");

    const invalid = [
      `${valid}x`,
      signHostSession({ sub: "host-shopper", exp: now - 1 }, secret),
      signHostSession({ sub: "host-shopper", exp: now + 24 * 60 * 60 + 1 }, secret),
      signHostSession({ sub: "", exp: now + 3600 }, secret),
      signHostSession(
        { sub: "host-shopper", email: "customer@example.com", emailVerified: true, exp: now + 3600 },
        Buffer.alloc(32, 8),
      ),
    ];
    for (const token of invalid) {
      h.models["test:primary"] = scriptedModel([
        callTool("lookup", "lookup_order", { orderNumber: "ACE-1001" }),
        say("Please verify."),
      ]);
      expect(uiTypes(await h.chat({ message: "track ACE-1001", identityToken: token }))).toContain(
        "verification_form",
      );
    }
    const unverifiedEmail = signHostSession(
      { sub: "host-shopper", email: "customer@example.com", emailVerified: false, exp: now + 3600 },
      secret,
    );
    expect(verifyHostSession(unverifiedEmail, secret)).toMatchObject({
      method: "host_session",
      externalCustomerId: "host-shopper",
    });
    expect(verifyHostSession(unverifiedEmail, secret)).not.toHaveProperty("email");
  });
});

describe("identity-confusion release gate", () => {
  it("ties matching to the verified method and preserves phone/email normalization boundaries", () => {
    const email: VerifiedIdentity = {
      method: "email_otp",
      email: "different@example.com",
      verifiedAt: VERIFIED_AT,
    };
    const phone: VerifiedIdentity = {
      method: "phone_otp",
      phone: "+94771234567",
      verifiedAt: VERIFIED_AT,
    };
    expect(identityMatches(email, { email: "owner@example.com", phone: "+94771234567" })).toBe(false);
    expect(identityMatches(phone, { email: "different@example.com", phone: "077 123 4567" })).toBe(true);
    expect(identityMatches(phone, { email: "different@example.com", phone: "+94770000000" })).toBe(false);
    expect(["+94771234567", "0771234567", "94771234567"].map((value) => normalizePhone(value))).toEqual([
      "+94771234567",
      "+94771234567",
      "+94771234567",
    ]);
    expect(normalizeEmail(" Customer@Example.COM ")).toBe("customer@example.com");
    expect(normalizeEmail("first.last@gmail.com")).not.toBe(normalizeEmail("firstlast@gmail.com"));
    expect(normalizeEmail("a+tag@gmail.com")).not.toBe(normalizeEmail("a@gmail.com"));
  });
});
