import { randomUUID } from "node:crypto";
import { say, scriptedModel } from "@ace/agent/testing";
import { acquireTurnLease, schema, withTenant } from "@ace/db";
import { createTestDatabase } from "@ace/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEngineHarness } from "../testing/harness";

const testDb = await createTestDatabase();

describe.skipIf(testDb === null)("POST /v1/actions/:type", () => {
  let h: Awaited<ReturnType<typeof createEngineHarness>>;

  beforeAll(async () => {
    if (testDb) h = await createEngineHarness(testDb);
  });
  afterAll(async () => {
    await h?.close();
    await testDb?.drop();
  });

  async function newConversation() {
    h.models["test:primary"] = scriptedModel([say("Hello!")]);
    const events = await h.chat({ message: "hi" });
    const data = events.find((e) => e.event === "conversation")?.data ?? {};
    return { conversationId: String(data.conversationId), conversationToken: String(data.conversationToken) };
  }

  it("adds to the cart without a model and tells the next turn about it", async () => {
    const ids = await newConversation();
    const res = await h.post("/v1/actions/add_to_cart", {
      ...ids,
      actionId: randomUUID(),
      input: { variantId: "p_kurta_navy_m", quantity: 1 },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { ok: boolean }; ui: { type: string }[]; cartId: string };
    expect(body.result.ok).toBe(true);
    expect(body.ui.map((part) => part.type)).toEqual(["cart"]);
    expect((await h.provider().getCart(body.cartId))?.itemCount).toBe(1);

    const model = scriptedModel([say("Nice choice.")]);
    h.models["test:primary"] = model;
    await h.chat({ ...ids, message: "what did I add?" });
    expect(JSON.stringify(model.doGenerateCalls[0]?.prompt)).toContain("[shopper action] add_to_cart");
  });

  it("applies a repeated actionId once (double click)", async () => {
    const ids = await newConversation();
    const action = {
      ...ids,
      actionId: randomUUID(),
      input: { variantId: "p_oxford_shirt_white_m", quantity: 1 },
    };
    const first = (await (await h.post("/v1/actions/add_to_cart", action)).json()) as { cartId: string };
    const second = (await (await h.post("/v1/actions/add_to_cart", action)).json()) as { cartId: string };
    expect(second.cartId).toBe(first.cartId);
    expect((await h.provider().getCart(first.cartId))?.itemCount).toBe(1);
  });

  it("changes a line's quantity and starts checkout", async () => {
    const ids = await newConversation();
    const added = (await (
      await h.post("/v1/actions/add_to_cart", {
        ...ids,
        actionId: randomUUID(),
        input: { variantId: "p_kurta_navy_l", quantity: 1 },
      })
    ).json()) as { result: { data: { lines: { lineId: string }[] } } };
    const lineId = added.result.data.lines[0]?.lineId;
    const updated = (await (
      await h.post("/v1/actions/update_cart_line", {
        ...ids,
        actionId: randomUUID(),
        input: { lineId, quantity: 3 },
      })
    ).json()) as { result: { data: { itemCount: number } } };
    expect(updated.result.data.itemCount).toBe(3);
    const checkout = (await (
      await h.post("/v1/actions/start_checkout", { ...ids, actionId: randomUUID(), input: {} })
    ).json()) as { ui: { type: string }[] };
    expect(checkout.ui.map((part) => part.type)).toEqual(["checkout"]);
  });

  it("places a cash-on-delivery order only after the shopper confirms, keeping no personal data in records", async () => {
    const ids = await newConversation();
    const act = async (type: string, input: unknown, actionId: string = randomUUID()) =>
      (await (await h.post(`/v1/actions/${type}`, { ...ids, actionId, input })).json()) as {
        result: { ok: boolean; data?: { orderNumber?: string }; error?: { code: string } };
        ui: { type: string; total?: { amount: number }; order?: { number: string } }[];
        cartId: string | null;
      };
    await act("add_to_cart", { variantId: "p_kurta_navy_m", quantity: 1 });
    expect((await act("place_cod_order", {})).result.error?.code).toBe("NO_DRAFT");

    const details = {
      name: "Nimali Perera",
      phone: "077 123 4567",
      address: { line1: "12 Galle Road", city: "Colombo", countryCode: "LK" },
    };
    expect(
      (await h.post(`/v1/actions/cod_quote`, { ...ids, actionId: randomUUID(), input: { name: "x" } }))
        .status,
    ).toBe(400);
    const quoted = await act("cod_quote", details);
    expect(quoted.ui[0]).toMatchObject({ type: "cod_summary", total: { amount: 830000 } });

    const confirmId = randomUUID();
    const placed = await act("place_cod_order", {}, confirmId);
    expect(placed.result.ok).toBe(true);
    expect(placed.ui[0]?.type).toBe("order");
    expect(placed.cartId).toBeNull();
    const again = await act("place_cod_order", {}, confirmId);
    expect(again.ui[0]?.order?.number).toBe(placed.ui[0]?.order?.number);
    const owner = {
      method: "phone_otp",
      phone: "+94771234567",
      verifiedAt: "2026-10-09T00:00:00.000Z",
    } as const;
    const orders = await h.provider().listOrders({ identity: owner, limit: 20 });
    expect(orders.filter((order) => order.number === placed.ui[0]?.order?.number)).toHaveLength(1);

    const stored = await withTenant(h.pool.db, h.tenantId, async (tx) => ({
      calls: await tx
        .select()
        .from(schema.toolCalls)
        .where(eq(schema.toolCalls.conversationId, ids.conversationId)),
      messages: await tx
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, ids.conversationId)),
      conversation: await tx
        .select({ session: schema.conversations.session })
        .from(schema.conversations)
        .where(eq(schema.conversations.id, ids.conversationId)),
    }));
    expect(JSON.stringify(stored.messages)).toContain(
      `place_cod_order {} → done (order ${placed.ui[0]?.order?.number})`,
    );
    const text = JSON.stringify([stored.calls, stored.messages]);
    for (const secret of ["Nimali", "771234567", "Galle Road"]) expect(text).not.toContain(secret);
    expect(JSON.stringify(stored.conversation)).not.toContain("Galle Road");
  });

  it("enforces the bot's cash-on-delivery limit in code", async () => {
    const ids = await newConversation();
    // Harness bot: COD up to LKR 50,000. Three dresses (LKR 55,500) are over it.
    await h.post("/v1/actions/add_to_cart", {
      ...ids,
      actionId: randomUUID(),
      input: { variantId: "p_wrap_dress_black_m", quantity: 3 },
    });
    const res = await h.post("/v1/actions/cod_quote", {
      ...ids,
      actionId: randomUUID(),
      input: { name: "A", phone: "0771234567", address: { line1: "x", city: "Kandy", countryCode: "LK" } },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { result: { error: { code: string } } }).result.error.code).toBe(
      "COD_LIMIT",
    );
  });

  it("refuses unknown types, bad input, missing tokens and busy conversations", async () => {
    const ids = await newConversation();
    const ok = { ...ids, actionId: randomUUID(), input: { variantId: "p_kurta_navy_m", quantity: 1 } };
    expect((await h.post("/v1/actions/refund", ok)).status).toBe(404);
    expect((await h.post("/v1/actions/add_to_cart", { ...ok, input: { ref: "#1" } })).status).toBe(400);
    expect((await h.post("/v1/actions/add_to_cart", { ...ok, actionId: "not-a-uuid" })).status).toBe(400);
    expect((await h.post("/v1/actions/add_to_cart", { ...ok, conversationToken: "nope" })).status).toBe(404);
    await withTenant(h.pool.db, h.tenantId, (tx) => acquireTurnLease(tx, ids.conversationId, 60_000));
    expect((await h.post("/v1/actions/add_to_cart", ok)).status).toBe(409);
  });
});
