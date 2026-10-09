import { MoneySchema } from "@ace/contracts";
import { z } from "zod";

const ProductEvent = z.object({
  eventId: z.string().min(1).max(200),
  type: z.enum(["product.updated", "product.deleted", "inventory.updated"]),
  productId: z.string().min(1).max(200),
  occurredAt: z.iso.datetime(),
});

const OrderPlacedEvent = z.object({
  eventId: z.string().min(1).max(200),
  type: z.literal("order.placed"),
  orderId: z.string().min(1),
  orderNumber: z.string().min(1),
  total: MoneySchema,
  placedAt: z.iso.datetime(),
  attributes: z.record(z.string(), z.string()),
});

/** ACE webhook v1 body. Platforms with their own webhook formats get their own verifiers and translators. */
export const AceWebhookSchema = z.discriminatedUnion("type", [ProductEvent, OrderPlacedEvent]);
export type AceWebhook = z.infer<typeof AceWebhookSchema>;
