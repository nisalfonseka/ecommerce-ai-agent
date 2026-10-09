import { randomUUID } from "node:crypto";
import { say, scriptedModel } from "@ace/agent/testing";
import { acquireTurnLease, withTenant } from "@ace/db";
import { createTestDatabase } from "@ace/db/testing";
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
