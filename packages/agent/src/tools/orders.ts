import { z } from "zod";
import { observeMoney } from "../context";
import { formatMoney } from "../format";
import { runTool, ToolFailure } from "../tool-result";
import { defineTool } from "./define";

export const lookupOrderTool = defineTool({
  name: "lookup_order",
  description:
    "Look up the status and tracking of the shopper's order by order number. If it answers NEEDS_VERIFICATION, ask the shopper to verify their email or phone using the form shown; never ask for passwords.",
  requires: ["orders.lookup"],
  inputSchema: z.object({ orderNumber: z.string().trim().min(1).max(64) }),
  run: (ctx, input) =>
    runTool(async () => {
      if (ctx.identity === null) {
        ctx.ui.push({ type: "verification_required", reason: "order_lookup" });
        throw new ToolFailure(
          "NEEDS_VERIFICATION",
          "The shopper must verify their email or phone before order details can be shown.",
        );
      }
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
