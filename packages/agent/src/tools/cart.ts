import {
  ATTRIBUTION_ATTRIBUTE,
  type Cart,
  CommerceError,
  isCommerceError,
  MAX_LINE_QUANTITY,
  type Variant,
} from "@ace/contracts";
import { z } from "zod";
import { observeMoney, type ToolContext, writeKey } from "../context";
import { formatMoney } from "../format";
import { runTool, ToolFailure } from "../tool-result";
import { defineTool } from "./define";
import { resolveProductId } from "./resolve";

export function compactCart(cart: Cart) {
  return {
    itemCount: cart.itemCount,
    subtotal: cart.lines.length > 0 ? formatMoney(cart.subtotal) : null,
    lines: cart.lines.map((line) => ({
      lineId: line.id,
      title: line.title,
      variantTitle: line.variantTitle,
      quantity: line.quantity,
      lineTotal: formatMoney(line.lineTotal),
    })),
  };
}

function showCart(ctx: ToolContext, cart: Cart) {
  observeMoney(ctx, cart);
  ctx.ui.push({ type: "cart", cart });
  return compactCart(cart);
}

/** Uses the host site's cart (tagging each cart for attribution once) or creates a tagged cart. */
export async function ensureCart(ctx: ToolContext, toolCallId: string): Promise<string> {
  const attributes = { [ATTRIBUTION_ATTRIBUTE]: ctx.conversationId };
  if (ctx.cartId !== null) {
    if (ctx.session.attributedCartId === ctx.cartId) return ctx.cartId;
    try {
      await ctx.provider.updateCartAttributes(
        ctx.cartId,
        { attributes },
        writeKey(ctx, `${toolCallId}:attr`),
      );
      ctx.session.attributedCartId = ctx.cartId;
      return ctx.cartId;
    } catch (error) {
      if (!(isCommerceError(error) && error.code === "NOT_FOUND")) throw error;
    }
  }
  const cart = await ctx.provider.createCart({ attributes }, writeKey(ctx, `${toolCallId}:cart`));
  ctx.cartId = cart.id;
  ctx.session.attributedCartId = cart.id;
  return cart.id;
}

function requireCartId(ctx: ToolContext): string {
  if (ctx.cartId === null)
    throw new ToolFailure("NO_CART", "The shopper has no cart yet. Add a product first.");
  return ctx.cartId;
}

function pickVariant(
  variants: Variant[],
  wanted: { size?: string | undefined; color?: string | undefined },
): Variant {
  const matches = variants.filter(
    (variant) =>
      (wanted.size === undefined || variant.options.size?.toLowerCase() === wanted.size.toLowerCase()) &&
      (wanted.color === undefined || variant.options.color?.toLowerCase() === wanted.color.toLowerCase()),
  );
  const [only] = matches;
  if (matches.length === 1 && only) return only;
  const options: Record<string, string[]> = {};
  for (const variant of variants) {
    for (const [name, value] of Object.entries(variant.options)) {
      const values = options[name] ?? [];
      if (!values.includes(value)) values.push(value);
      options[name] = values;
    }
  }
  const varying = Object.fromEntries(Object.entries(options).filter(([, values]) => values.length > 1));
  throw new ToolFailure(
    "NEEDS_OPTIONS",
    matches.length === 0
      ? "No variant matches those options. Ask the shopper to choose."
      : "Ask the shopper which option they want.",
    { options: varying },
  );
}

export const viewCartTool = defineTool({
  name: "view_cart",
  description: "Show the shopper's current cart with line IDs, quantities and subtotal.",
  requires: ["cart.write"],
  inputSchema: z.object({}),
  run: (ctx) =>
    runTool(async () => {
      const cart = ctx.cartId === null ? null : await ctx.provider.getCart(ctx.cartId);
      if (!cart) return { itemCount: 0, subtotal: null, lines: [] };
      return showCart(ctx, cart);
    }),
});

export const addToCartTool = defineTool({
  name: "add_to_cart",
  description:
    "Add a product to the shopper's cart. Identify it by #number from the latest results (or productId) plus size/colour, or by variantId. If the tool answers NEEDS_OPTIONS, ask the shopper to choose.",
  requires: ["catalog.read", "cart.write"],
  inputSchema: z.object({
    ref: z.string().optional(),
    productId: z.string().optional(),
    variantId: z.string().optional(),
    size: z.string().optional(),
    color: z.string().optional(),
    quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY).default(1),
  }),
  run: (ctx, input, toolCallId) =>
    runTool(async () => {
      let variantId = input.variantId;
      if (variantId === undefined) {
        const productId = resolveProductId(ctx, input);
        const product = await ctx.provider.getProduct(productId);
        if (!product) throw new CommerceError("NOT_FOUND", `No product with id ${productId}.`, { productId });
        variantId = pickVariant(product.variants, input).id;
      }
      const cartId = await ensureCart(ctx, toolCallId);
      const cart = await ctx.provider.addCartLines(
        cartId,
        { lines: [{ variantId, quantity: input.quantity }] },
        writeKey(ctx, toolCallId),
      );
      return showCart(ctx, cart);
    }),
});

export const updateCartLineTool = defineTool({
  name: "update_cart_line",
  description:
    "Change the quantity of a cart line (lineId from view_cart or add_to_cart). Quantity 0 removes it.",
  requires: ["cart.write"],
  inputSchema: z.object({
    lineId: z.string().min(1),
    quantity: z.number().int().min(0).max(MAX_LINE_QUANTITY),
  }),
  run: (ctx, input, toolCallId) =>
    runTool(async () => {
      const cart = await ctx.provider.updateCartLine(requireCartId(ctx), input, writeKey(ctx, toolCallId));
      return showCart(ctx, cart);
    }),
});

export const startCheckoutTool = defineTool({
  name: "start_checkout",
  description:
    "When the shopper wants to pay, re-check the cart and show the store's checkout button. Never ask for card details; payment happens on the store's checkout page.",
  requires: ["cart.write", "checkout.handoff"],
  inputSchema: z.object({}),
  run: (ctx, _input, toolCallId) =>
    runTool(async () => {
      const checkout = await ctx.provider.createCheckout(requireCartId(ctx), writeKey(ctx, toolCallId));
      ctx.ui.push({ type: "checkout", checkout });
      return {
        checkoutShown: true,
        note: "A checkout button is now shown to the shopper. Do not paste the link.",
      };
    }),
});
