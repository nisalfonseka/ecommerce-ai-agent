import { z } from "zod";
import { MoneySchema } from "./money";

const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * Normalises a shopper-typed phone number to E.164, or null. Numbers without a country code are read as Sri
 * Lankan (the primary market, spec A1): "077 123 4567" → "+94771234567".
 */
export function normalizePhone(value: string): string | null {
  const compact = value.replace(/[\s\-().]/g, "");
  let candidate = compact;
  if (/^0\d{9}$/.test(compact)) candidate = `+94${compact.slice(1)}`;
  else if (/^94\d{9}$/.test(compact)) candidate = `+${compact}`;
  return E164.test(candidate) ? candidate : null;
}

const PhoneSchema = z.string().transform((value, ctx) => {
  const phone = normalizePhone(value);
  if (phone === null) {
    ctx.addIssue({ code: "custom", message: "a mobile number, e.g. 077 123 4567" });
    return z.NEVER;
  }
  return phone;
});

const text = (max: number) => z.string().trim().min(1).max(max);

/**
 * Delivery details for a cash-on-delivery order. They come from the shopper's form in the widget, never from
 * model output, and are personal data: store them only where the purge and export jobs can reach them.
 */
export const CodDetailsSchema = z.object({
  name: text(120),
  phone: PhoneSchema,
  email: z.email().optional(),
  address: z.object({
    line1: text(200),
    line2: z.string().trim().max(200).optional(),
    city: text(80),
    district: z.string().trim().max(80).optional(),
    postalCode: z.string().trim().max(12).optional(),
    countryCode: z.string().regex(/^[A-Z]{2}$/, "ISO 3166-1 alpha-2, e.g. LK"),
  }),
  note: z.string().trim().max(500).optional(),
});
export type CodDetailsInput = z.input<typeof CodDetailsSchema>;
export type CodDetails = z.output<typeof CodDetailsSchema>;

/** What the shopper confirms. Amounts are the store's (delivery fee included); total = subtotal + deliveryFee. */
export const CodQuoteSchema = z
  .object({
    cartId: z.string().min(1),
    subtotal: MoneySchema,
    deliveryFee: MoneySchema,
    total: MoneySchema,
    itemCount: z.number().int().positive(),
  })
  .refine(
    (quote) =>
      quote.subtotal.currency === quote.deliveryFee.currency &&
      quote.subtotal.currency === quote.total.currency &&
      quote.total.amount === quote.subtotal.amount + quote.deliveryFee.amount,
    { message: "total must be subtotal + deliveryFee in one currency" },
  );
export type CodQuote = z.infer<typeof CodQuoteSchema>;
