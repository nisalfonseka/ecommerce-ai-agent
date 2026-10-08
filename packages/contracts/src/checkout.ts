import { z } from "zod";

/** The shopper finishes payment on the store's own checkout page at `url`. */
export const CheckoutHandoffSchema = z.object({
  cartId: z.string().min(1),
  url: z.url(),
  expiresAt: z.iso.datetime().nullable(),
});
export type CheckoutHandoff = z.infer<typeof CheckoutHandoffSchema>;
