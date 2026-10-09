import { MemoryCommerceProvider } from "@ace/adapter-memory";
import { describe, expect, it } from "vitest";
import { createToolContext } from "../context";
import { createSession } from "../session";
import { addToCartTool, startCheckoutTool, updateCartLineTool, viewCartTool } from "./cart";
import { searchProductsTool } from "./catalog";

function make(cartId: string | null = null, provider = new MemoryCommerceProvider()) {
  return createToolContext({
    provider,
    conversationId: "conv_9",
    turnId: "t1",
    session: createSession(),
    cartId,
  });
}

describe("add_to_cart", () => {
  it("creates a tagged cart, adds the resolved variant and reports the cart", async () => {
    const ctx = make();
    await searchProductsTool.run(ctx, { query: "black" }, "c1");
    const dressRef = ctx.session.shown.find((s) => s.productId === "p_wrap_dress_black")?.ref ?? "#0";
    const result = await addToCartTool.run(ctx, { ref: dressRef, size: "M", quantity: 1 }, "c2");
    expect(result).toMatchObject({
      ok: true,
      data: {
        itemCount: 1,
        subtotal: "LKR 18,500.00",
        lines: [{ title: "Black Satin Wrap Dress", variantTitle: "Black / M" }],
      },
    });
    expect(ctx.cartId).not.toBeNull();
    const cart = await ctx.provider.getCart(ctx.cartId ?? "");
    expect(cart?.attributes).toEqual({ ace_conversation_id: "conv_9" });
    expect(ctx.ui.at(-1)?.type).toBe("cart");
  });

  it("asks for options when the variant is ambiguous and changes nothing", async () => {
    const ctx = make();
    const result = await addToCartTool.run(ctx, { productId: "p_linen_shirt_black", quantity: 1 }, "c1");
    expect(result).toMatchObject({
      ok: false,
      error: { code: "NEEDS_OPTIONS", details: { options: { size: ["S", "M", "L"] } } },
    });
    expect(ctx.cartId).toBeNull();
  });

  it("reuses the host cart and tags it once", async () => {
    const provider = new MemoryCommerceProvider();
    const host = await provider.createCart({}, { idempotencyKey: "host-cart-1" });
    const ctx = make(host.id, provider);
    await addToCartTool.run(ctx, { productId: "p_kurta_navy", size: "M", quantity: 1 }, "c1");
    await addToCartTool.run(ctx, { productId: "p_kurta_navy", size: "L", quantity: 1 }, "c2");
    expect(ctx.cartId).toBe(host.id);
    expect(ctx.session.attributedCartId).toBe(host.id);
    const cart = await provider.getCart(host.id);
    expect(cart?.itemCount).toBe(2);
    expect(cart?.attributes.ace_conversation_id).toBe("conv_9");
  });

  it("tags a new host cart that replaces an already tagged one", async () => {
    const provider = new MemoryCommerceProvider();
    const session = createSession();
    const first = await provider.createCart({}, { idempotencyKey: "host-cart-1" });
    const turn1 = createToolContext({
      provider,
      conversationId: "conv_9",
      turnId: "t1",
      session,
      cartId: first.id,
    });
    await addToCartTool.run(turn1, { productId: "p_kurta_navy", size: "M", quantity: 1 }, "c1");
    // The shopper checked out; the site now passes a fresh cart in the same conversation.
    const second = await provider.createCart({}, { idempotencyKey: "host-cart-2" });
    const turn2 = createToolContext({
      provider,
      conversationId: "conv_9",
      turnId: "t2",
      session,
      cartId: second.id,
    });
    await addToCartTool.run(turn2, { productId: "p_kurta_navy", size: "L", quantity: 1 }, "c1");
    expect((await provider.getCart(second.id))?.attributes.ace_conversation_id).toBe("conv_9");
  });

  it("replaces a host cart that no longer exists with a new tagged cart", async () => {
    const ctx = make("cart_gone");
    const result = await addToCartTool.run(ctx, { productId: "p_kurta_navy", size: "M", quantity: 1 }, "c1");
    expect(result.ok).toBe(true);
    expect(ctx.cartId).not.toBe("cart_gone");
    expect((await ctx.provider.getCart(ctx.cartId ?? ""))?.attributes.ace_conversation_id).toBe("conv_9");
  });

  it("passes OUT_OF_STOCK through with what is available", async () => {
    const ctx = make();
    const result = await addToCartTool.run(
      ctx,
      { productId: "p_linen_shirt_black", size: "L", quantity: 1 },
      "c1",
    );
    expect(result).toMatchObject({ ok: false, error: { code: "OUT_OF_STOCK", details: { available: 0 } } });
  });

  it("fails with UNKNOWN_REF for a stale reference", async () => {
    const result = await addToCartTool.run(make(), { ref: "#3", size: "M", quantity: 1 }, "c1");
    expect(result).toMatchObject({ ok: false, error: { code: "UNKNOWN_REF" } });
  });
});

describe("view_cart / update_cart_line / start_checkout", () => {
  it("reports an empty cart when none exists", async () => {
    expect(await viewCartTool.run(make(), {}, "c1")).toEqual({
      ok: true,
      data: { itemCount: 0, subtotal: null, lines: [] },
    });
  });

  it("changes and removes lines, then refuses checkout on an empty cart", async () => {
    const ctx = make();
    const added = await addToCartTool.run(ctx, { productId: "p_kurta_navy", size: "M", quantity: 1 }, "c1");
    const lineId = added.ok ? (added.data.lines[0]?.lineId ?? "") : "";
    const changed = await updateCartLineTool.run(ctx, { lineId, quantity: 3 }, "c2");
    expect(changed).toMatchObject({ ok: true, data: { itemCount: 3 } });
    await updateCartLineTool.run(ctx, { lineId, quantity: 0 }, "c3");
    expect(await startCheckoutTool.run(ctx, {}, "c4")).toMatchObject({
      ok: false,
      error: { code: "CONFLICT" },
    });
  });

  it("hands off a non-empty cart to checkout and shows the button", async () => {
    const ctx = make();
    await addToCartTool.run(ctx, { productId: "p_kurta_navy", size: "M", quantity: 1 }, "c1");
    const result = await startCheckoutTool.run(ctx, {}, "c2");
    expect(result).toMatchObject({ ok: true, data: { checkoutShown: true } });
    expect(ctx.ui.at(-1)).toMatchObject({ type: "checkout", checkout: { cartId: ctx.cartId } });
  });

  it("needs a cart for update and checkout", async () => {
    expect(await updateCartLineTool.run(make(), { lineId: "l1", quantity: 1 }, "c1")).toMatchObject({
      ok: false,
      error: { code: "NO_CART" },
    });
    expect(await startCheckoutTool.run(make(), {}, "c1")).toMatchObject({
      ok: false,
      error: { code: "NO_CART" },
    });
  });
});
