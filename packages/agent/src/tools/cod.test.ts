import { MemoryCommerceProvider } from "@ace/adapter-memory";
import { ATTRIBUTION_ATTRIBUTE } from "@ace/contracts";
import { describe, expect, it } from "vitest";
import { type CodPolicy, createToolContext, type ToolContext } from "../context";
import { createSession } from "../session";
import { addToCartTool } from "./cart";
import { codQuoteAction, placeCodOrderAction, startCodOrderTool } from "./cod";
import { ACTION_TOOLS, ALL_TOOLS, buildTools } from "./registry";

const details = {
  name: "Nimali Perera",
  phone: "077 123 4567",
  address: { line1: "12 Galle Road", city: "Colombo 03", countryCode: "LK" },
};

async function withCart(cod: CodPolicy | null = { maxTotal: null, allowedCities: null, countryCode: "LK" }) {
  const provider = new MemoryCommerceProvider();
  const ctx = createToolContext({
    provider,
    conversationId: "conv_cod",
    turnId: "t1",
    session: createSession(),
    cod,
  });
  await addToCartTool.run(ctx, { variantId: "p_wrap_dress_black_m", quantity: 1 }, "add");
  ctx.ui.length = 0;
  return { ctx, provider };
}

/** A later request in the same conversation: same session and cart, fresh UI and turn. */
function nextRequest(ctx: ToolContext, turnId: string): ToolContext {
  return createToolContext({
    provider: ctx.provider,
    conversationId: ctx.conversationId,
    turnId,
    session: ctx.session,
    cartId: ctx.cartId,
    cod: ctx.cod,
  });
}

describe("start_cod_order (model tool)", () => {
  it("shows the delivery form for a non-empty cart and takes no personal data", async () => {
    const { ctx } = await withCart();
    expect(Object.keys(startCodOrderTool.inputSchema.parse({}))).toEqual([]);
    const result = await startCodOrderTool.run(ctx, {}, "c1");
    expect(result).toMatchObject({ ok: true, data: { formShown: true, itemCount: 1 } });
    expect(ctx.ui).toEqual([
      { type: "delivery_form", cartId: ctx.cartId, countryCode: "LK", cities: null, prefill: null },
    ]);
  });

  it("refuses an empty cart and orders over the COD limit", async () => {
    const empty = createToolContext({
      provider: new MemoryCommerceProvider(),
      conversationId: "c",
      turnId: "t",
      cod: { maxTotal: null, allowedCities: null, countryCode: "LK" },
    });
    expect(await startCodOrderTool.run(empty, {}, "c1")).toMatchObject({
      ok: false,
      error: { code: "NO_CART" },
    });
    const { ctx } = await withCart({
      maxTotal: { amount: 1000000, currency: "LKR" },
      allowedCities: null,
      countryCode: "LK",
    });
    expect(await startCodOrderTool.run(ctx, {}, "c1")).toMatchObject({
      ok: false,
      error: { code: "COD_LIMIT" },
    });
  });

  it("is only offered to the model when COD is enabled and supported, and the model never gets the order tools", async () => {
    const { ctx } = await withCart();
    const names = Object.keys(buildTools(ctx));
    expect(names).toContain("start_cod_order");
    expect(names).not.toContain("cod_quote");
    expect(names).not.toContain("place_cod_order");
    expect(ALL_TOOLS.map((tool) => tool.name)).not.toContain("place_cod_order");
    expect(ACTION_TOOLS.map((tool) => tool.name)).toEqual(["cod_quote", "place_cod_order"]);
    const disabled = await withCart(null);
    expect(Object.keys(buildTools(disabled.ctx))).not.toContain("start_cod_order");
  });
});

describe("cod_quote (form action)", () => {
  it("quotes with the delivery fee, keeps a draft and shows the summary", async () => {
    const { ctx } = await withCart();
    const result = await codQuoteAction.run(ctx, details, "action");
    expect(result).toMatchObject({ ok: true, data: { total: "LKR 18,900.00" } });
    expect(ctx.session.codDraft).toMatchObject({
      cartId: ctx.cartId,
      details: { phone: "+94771234567", name: "Nimali Perera" },
      total: { amount: 1890000, currency: "LKR" },
    });
    expect(ctx.ui[0]).toMatchObject({
      type: "cod_summary",
      subtotal: { amount: 1850000 },
      deliveryFee: { amount: 40000 },
      total: { amount: 1890000 },
      deliverTo: { name: "Nimali Perera", phone: "+94771234567", line1: "12 Galle Road", city: "Colombo 03" },
    });
  });

  it("enforces the allowed cities and the COD limit in code", async () => {
    const cities = await withCart({
      maxTotal: null,
      allowedCities: ["Colombo 03", "Kandy"],
      countryCode: "LK",
    });
    expect(
      await codQuoteAction.run(
        cities.ctx,
        { ...details, address: { ...details.address, city: "Jaffna" } },
        "a",
      ),
    ).toMatchObject({ ok: false, error: { code: "COD_UNAVAILABLE" } });
    expect(
      (
        await codQuoteAction.run(
          cities.ctx,
          { ...details, address: { ...details.address, city: "kandy" } },
          "a",
        )
      ).ok,
    ).toBe(true);
    const limit = await withCart({
      maxTotal: { amount: 1850000, currency: "LKR" },
      allowedCities: null,
      countryCode: "LK",
    });
    expect(await codQuoteAction.run(limit.ctx, details, "a")).toMatchObject({
      ok: false,
      error: { code: "COD_LIMIT" },
    });
    expect(limit.ctx.session.codDraft ?? null).toBeNull();
  });
});

describe("place_cod_order (confirm action)", () => {
  it("refuses without a draft from the summary", async () => {
    const { ctx } = await withCart();
    expect(await placeCodOrderAction.run(ctx, {}, "action")).toMatchObject({
      ok: false,
      error: { code: "NO_DRAFT" },
    });
  });

  it("places one order for the confirmed draft, with attribution, and forgets the completed cart", async () => {
    const { ctx, provider } = await withCart();
    await codQuoteAction.run(ctx, details, "action");
    const confirm = nextRequest(ctx, "action-1");
    const cartId = confirm.cartId ?? "";
    expect((await provider.getCart(cartId))?.attributes[ATTRIBUTION_ATTRIBUTE]).toBe("conv_cod");
    const result = await placeCodOrderAction.run(confirm, {}, "action");
    expect(result).toMatchObject({ ok: true, data: { total: "LKR 18,900.00" } });
    expect(confirm.ui[0]).toMatchObject({ type: "order", order: { paymentStatus: "cod_pending" } });
    expect(confirm.cartId).toBeNull();
    expect(confirm.session.codDraft ?? null).toBeNull();
    const owner = {
      method: "phone_otp",
      phone: "+94771234567",
      verifiedAt: "2026-10-09T00:00:00.000Z",
    } as const;
    expect(await provider.listOrders({ identity: owner })).toHaveLength(2);
  });

  it("returns the same order when the confirm request is retried, and places nothing twice", async () => {
    const { ctx, provider } = await withCart();
    await codQuoteAction.run(ctx, details, "action");
    const first = nextRequest(ctx, "action-1");
    const placed = await placeCodOrderAction.run(first, {}, "action");
    const retry = nextRequest(first, "action-1");
    expect(await placeCodOrderAction.run(retry, {}, "action")).toEqual(placed);
    expect(retry.ui[0]).toMatchObject({ type: "order" });
    const owner = {
      method: "phone_otp",
      phone: "+94771234567",
      verifiedAt: "2026-10-09T00:00:00.000Z",
    } as const;
    expect(await provider.listOrders({ identity: owner })).toHaveLength(2);
  });

  it("shows a new summary instead of ordering when the total changed since the shopper saw it", async () => {
    const { ctx, provider } = await withCart();
    await codQuoteAction.run(ctx, details, "action");
    await addToCartTool.run(nextRequest(ctx, "t2"), { variantId: "p_kurta_navy_m", quantity: 1 }, "add2");
    const confirm = nextRequest(ctx, "action-2");
    expect(await placeCodOrderAction.run(confirm, {}, "action")).toMatchObject({
      ok: false,
      error: { code: "QUOTE_CHANGED" },
    });
    expect(confirm.ui[0]).toMatchObject({ type: "cod_summary", total: { amount: 2680000 } });
    const owner = {
      method: "phone_otp",
      phone: "+94771234567",
      verifiedAt: "2026-10-09T00:00:00.000Z",
    } as const;
    expect(await provider.listOrders({ identity: owner })).toHaveLength(1);
  });
});
