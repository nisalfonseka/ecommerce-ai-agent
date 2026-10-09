import { z } from "zod";
import { VerifiedIdentitySchema } from "./identity";
import { MoneySchema } from "./money";

export const OrderStatusSchema = z.enum([
  "pending",
  "confirmed",
  "processing",
  "shipped",
  "delivered",
  "cancelled",
  "returned",
]);

export const PaymentStatusSchema = z.enum(["pending", "paid", "cod_pending", "refunded", "failed"]);

/** Deliberately excludes addresses and payment details (data minimisation). */
export const OrderSchema = z.object({
  id: z.string().min(1),
  number: z.string().min(1),
  status: OrderStatusSchema,
  paymentStatus: PaymentStatusSchema,
  placedAt: z.iso.datetime(),
  total: MoneySchema,
  lines: z
    .array(
      z.object({
        title: z.string(),
        variantTitle: z.string(),
        quantity: z.number().int().positive(),
        unitPrice: MoneySchema,
      }),
    )
    .min(1),
  tracking: z.array(z.object({ carrier: z.string(), number: z.string(), url: z.url().optional() })),
});
export type Order = z.infer<typeof OrderSchema>;

export const LookupOrderInputSchema = z.object({
  orderNumber: z.string().trim().min(1).max(64),
  identity: VerifiedIdentitySchema,
});
export type LookupOrderInput = z.input<typeof LookupOrderInputSchema>;

export const ListOrdersInputSchema = z.object({
  identity: VerifiedIdentitySchema,
  limit: z.number().int().min(1).max(20).default(5),
});
export type ListOrdersInput = z.input<typeof ListOrdersInputSchema>;
