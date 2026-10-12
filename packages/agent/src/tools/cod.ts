import {
  type Cart,
  type CodDetails,
  CodDetailsSchema,
  type CodQuote,
  type Money,
  parseInput,
} from "@ace/contracts";
import { z } from "zod";
import { observeMoney, type ToolContext, writeKey } from "../context";
import { formatMoney } from "../format";
import type { CodDraft } from "../session";
import { runTool, ToolFailure } from "../tool-result";
import type { DeliveryPrefill } from "../ui";
import { ensureCart } from "./cart";
import { defineTool } from "./define";

const COD_CAPABILITIES = ["cart.write", "orders.place_cod"] as const;
const codEnabled = (ctx: ToolContext) => ctx.cod !== null;

async function requireFilledCart(ctx: ToolContext, toolCallId: string): Promise<Cart> {
  if (ctx.cartId === null) throw new ToolFailure("NO_CART", "The cart is empty. Add a product first.");
  // Tag the cart for attribution if the host site handed it over untagged.
  const cartId = await ensureCart(ctx, toolCallId);
  const cart = await ctx.provider.getCart(cartId);
  if (!cart || cart.lines.length === 0) {
    throw new ToolFailure("NO_CART", "The cart is empty. Add a product first.");
  }
  observeMoney(ctx, cart);
  return cart;
}

function assertWithinLimit(ctx: ToolContext, total: Money): void {
  const limit = ctx.cod?.maxTotal;
  if (limit && limit.currency === total.currency && total.amount > limit.amount) {
    throw new ToolFailure(
      "COD_LIMIT",
      `Cash on delivery is available for orders up to ${formatMoney(limit)}. Offer card payment at checkout instead.`,
      { maxTotal: formatMoney(limit) },
    );
  }
}

function assertCityAllowed(ctx: ToolContext, city: string): void {
  const allowed = ctx.cod?.allowedCities;
  if (allowed && !allowed.some((candidate) => candidate.trim().toLowerCase() === city.trim().toLowerCase())) {
    throw new ToolFailure(
      "COD_UNAVAILABLE",
      "Cash on delivery is not available for this city. Offer card payment at checkout instead.",
      { city },
    );
  }
}

function prefill(details: CodDetails): DeliveryPrefill {
  return {
    name: details.name,
    phone: details.phone,
    email: details.email,
    line1: details.address.line1,
    line2: details.address.line2,
    city: details.address.city,
    district: details.address.district,
    postalCode: details.address.postalCode,
    note: details.note,
  };
}

function showSummary(ctx: ToolContext, cart: Cart, draft: CodDraft): void {
  observeMoney(ctx, [draft.subtotal, draft.deliveryFee, draft.total]);
  ctx.ui.push({
    type: "cod_summary",
    cartId: draft.cartId,
    countryCode: draft.details.address.countryCode,
    lines: cart.lines,
    subtotal: draft.subtotal,
    deliveryFee: draft.deliveryFee,
    total: draft.total,
    deliverTo: prefill(draft.details),
  });
}

function draftFrom(cartId: string, details: CodDetails, quote: CodQuote): CodDraft {
  return {
    cartId,
    details,
    subtotal: quote.subtotal,
    deliveryFee: quote.deliveryFee,
    total: quote.total,
    itemCount: quote.itemCount,
  };
}

function sameQuote(draft: CodDraft, quote: CodQuote): boolean {
  return (
    draft.total.amount === quote.total.amount &&
    draft.total.currency === quote.total.currency &&
    draft.itemCount === quote.itemCount
  );
}

export const startCodOrderTool = defineTool({
  name: "start_cod_order",
  description:
    "Use when the shopper wants to pay cash on delivery (COD) for their cart. Shows a delivery form; the shopper fills in their details and confirms the order on the summary card themselves. Never ask for their name, phone number or address in chat, and never say the order is placed.",
  requires: [...COD_CAPABILITIES],
  available: codEnabled,
  inputSchema: z.object({}),
  run: (ctx, _input, toolCallId) =>
    runTool(async () => {
      const cart = await requireFilledCart(ctx, toolCallId);
      assertWithinLimit(ctx, cart.subtotal);
      const draft = ctx.session.codDraft;
      ctx.ui.push({
        type: "delivery_form",
        cartId: cart.id,
        countryCode: ctx.cod?.countryCode ?? "LK",
        cities: ctx.cod?.allowedCities ?? null,
        prefill: draft && draft.cartId === cart.id ? prefill(draft.details) : null,
      });
      return {
        formShown: true,
        itemCount: cart.itemCount,
        subtotal: formatMoney(cart.subtotal),
        note: "A delivery form is shown. The shopper confirms the order on the next card; it is not placed yet.",
      };
    }, ctx.onUnexpectedError),
});

/** Action only: the delivery form's submit. Quotes the order and shows the summary with Confirm. */
export const codQuoteAction = defineTool({
  name: "cod_quote",
  description: "Delivery form submitted by the shopper (UI action).",
  requires: [...COD_CAPABILITIES],
  available: codEnabled,
  sensitiveInput: true,
  inputSchema: CodDetailsSchema,
  run: (ctx, input, toolCallId) =>
    runTool(async () => {
      // Parsed again here: the form is shopper input, whoever called this.
      const details = parseInput(CodDetailsSchema, input);
      assertCityAllowed(ctx, details.address.city);
      const cart = await requireFilledCart(ctx, toolCallId);
      const quote = await ctx.provider.quoteCodOrder(cart.id, details);
      assertWithinLimit(ctx, quote.total);
      const draft = draftFrom(cart.id, details, quote);
      ctx.session.codDraft = draft;
      showSummary(ctx, cart, draft);
      return { total: formatMoney(quote.total), deliveryFee: formatMoney(quote.deliveryFee) };
    }, ctx.onUnexpectedError),
});

/**
 * Action only: the summary's Confirm button. Places the order exactly as quoted: if the total changed since
 * the shopper saw it, it shows the new summary instead (the shopper confirms again).
 */
export const placeCodOrderAction = defineTool({
  name: "place_cod_order",
  description: "Shopper confirmed the cash-on-delivery summary (UI action).",
  requires: [...COD_CAPABILITIES],
  available: codEnabled,
  inputSchema: z.object({}),
  run: (ctx, _input, toolCallId) =>
    runTool(async () => {
      const opts = writeKey(ctx, toolCallId);
      const draft = ctx.session.codDraft;
      const last = ctx.session.lastOrder;
      if (!draft && last?.key === opts.idempotencyKey) {
        ctx.ui.push({ type: "order", order: last.order });
        return { orderNumber: last.order.number, total: formatMoney(last.order.total) };
      }
      if (!draft || draft.cartId !== ctx.cartId) {
        throw new ToolFailure(
          "NO_DRAFT",
          "There is no delivery summary to confirm. Show the delivery form again.",
        );
      }
      assertCityAllowed(ctx, draft.details.address.city);
      const quote = await ctx.provider.quoteCodOrder(draft.cartId, draft.details);
      if (!sameQuote(draft, quote)) {
        const cart = await requireFilledCart(ctx, toolCallId);
        const updated = draftFrom(draft.cartId, draft.details, quote);
        ctx.session.codDraft = updated;
        showSummary(ctx, cart, updated);
        throw new ToolFailure(
          "QUOTE_CHANGED",
          "The cart changed, so the total changed. The shopper must confirm again.",
        );
      }
      assertWithinLimit(ctx, quote.total);
      const order = await ctx.provider.placeCodOrder(draft.cartId, draft.details, opts);
      observeMoney(ctx, order);
      ctx.session.codDraft = null;
      ctx.session.lastOrder = { key: opts.idempotencyKey, order };
      // The cart is now an order on the store; the next add starts a new cart.
      ctx.cartId = null;
      ctx.ui.push({ type: "order", order });
      return { orderNumber: order.number, total: formatMoney(order.total) };
    }, ctx.onUnexpectedError),
});
