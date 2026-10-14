import { z } from "zod";
import type { ToolContext } from "../context";
import { observeMoney } from "../context";
import { formatMoney } from "../format";
import { runTool, ToolFailure } from "../tool-result";
import { defineTool } from "./define";

function requireIdentity(ctx: ToolContext): void {
  if (ctx.identity !== null) return;
  if (ctx.verification) {
    ctx.ui.push({
      type: "verification_form",
      channels: ctx.verification.channels,
      reason: "order_lookup",
    });
  } else {
    ctx.ui.push({ type: "verification_required", reason: "order_lookup" });
  }
  throw new ToolFailure(
    "NEEDS_VERIFICATION",
    "The shopper must verify their email or phone before order details can be shown.",
  );
}

export const lookupOrderTool = defineTool({
  name: "lookup_order",
  description:
    "Look up an order by number for the server-verified shopper. If verification is needed, use the secure form shown; never ask for identity details in chat.",
  requires: ["orders.lookup"],
  inputSchema: z.strictObject({ orderNumber: z.string().trim().min(1).max(64) }),
  run: (ctx, input) =>
    runTool(async () => {
      requireIdentity(ctx);
      if (ctx.identity === null) throw new Error("identity invariant failed");
      const order = await ctx.provider.lookupOrder({
        orderNumber: input.orderNumber,
        identity: ctx.identity,
      });
      if (!order) {
        throw new ToolFailure(
          "NOT_FOUND",
          "No order with that number was found for this shopper. Ask them to check the number.",
        );
      }
      observeMoney(ctx, order);
      ctx.ui.push({ type: "order", order });
      return {
        number: order.number,
        status: order.status,
        paymentStatus: order.paymentStatus,
        placedAt: order.placedAt,
        total: formatMoney(order.total),
        items: order.lines.map((line) => ({
          title: line.title,
          variantTitle: line.variantTitle,
          quantity: line.quantity,
        })),
        tracking: order.tracking,
      };
    }, ctx.onUnexpectedError),
});

export const listOrdersTool = defineTool({
  name: "list_orders",
  description:
    "List up to five recent orders owned by the server-verified shopper. Use for all/recent orders, not when one order number was named.",
  requires: ["orders.lookup"],
  inputSchema: z.strictObject({ limit: z.number().int().min(1).max(5).default(5) }),
  run: (ctx, input) =>
    runTool(async () => {
      requireIdentity(ctx);
      if (ctx.identity === null) throw new Error("identity invariant failed");
      const orders = await ctx.provider.listOrders({ identity: ctx.identity, limit: input.limit });
      for (const order of orders) {
        observeMoney(ctx, order);
        ctx.ui.push({ type: "order", order });
      }
      return {
        orders: orders.map((order) => ({
          number: order.number,
          status: order.status,
          placedAt: order.placedAt,
          total: formatMoney(order.total),
        })),
      };
    }, ctx.onUnexpectedError),
});
