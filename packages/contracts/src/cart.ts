import { z } from "zod";
import { ImageSchema } from "./catalog";
import { CurrencyCodeSchema, MoneySchema } from "./money";

export const MAX_LINE_QUANTITY = 20;

/** Cart attribute that ties a cart (and the resulting order) to the ACE conversation. */
export const ATTRIBUTION_ATTRIBUTE = "ace_conversation_id";

export const CartLineSchema = z.object({
  id: z.string().min(1),
  productId: z.string().min(1),
  variantId: z.string().min(1),
  title: z.string(),
  variantTitle: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: MoneySchema,
  /**
   * Amounts are before discounts, tax and shipping; the store's checkout is authoritative for
   * the final total.
   */
  lineTotal: MoneySchema,
  image: ImageSchema.optional(),
});
export type CartLine = z.infer<typeof CartLineSchema>;

export const CartSchema = z.object({
  /** An opaque bearer identifier that must be hard to guess on real platforms. */
  id: z.string().min(1),
  currency: CurrencyCodeSchema,
  lines: z.array(CartLineSchema),
  /**
   * Amounts are before discounts, tax and shipping; the store's checkout is authoritative for
   * the final total.
   */
  subtotal: MoneySchema,
  itemCount: z.number().int().nonnegative(),
  attributes: z.record(z.string(), z.string()),
  updatedAt: z.iso.datetime(),
});
export type Cart = z.infer<typeof CartSchema>;

export const CreateCartInputSchema = z.object({
  currency: CurrencyCodeSchema.optional(),
  attributes: z.record(z.string().max(64), z.string().max(255)).default({}),
});
export type CreateCartInput = z.input<typeof CreateCartInputSchema>;

export const AddCartLinesInputSchema = z.object({
  lines: z
    .array(
      z.object({
        variantId: z.string().min(1),
        quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
      }),
    )
    .min(1)
    .max(20),
});
export type AddCartLinesInput = z.input<typeof AddCartLinesInputSchema>;

export const UpdateCartLineInputSchema = z.object({
  lineId: z.string().min(1),
  /** 0 removes the line. */
  quantity: z.number().int().min(0).max(MAX_LINE_QUANTITY),
});
export type UpdateCartLineInput = z.input<typeof UpdateCartLineInputSchema>;

export const WriteOptionsSchema = z.object({
  /** Same key + same operation + same target ⇒ the first result is returned again. */
  idempotencyKey: z.string().min(8).max(128),
});
export type WriteOptions = z.infer<typeof WriteOptionsSchema>;
