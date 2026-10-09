import { z } from "zod";
import { AvailabilitySchema } from "./catalog";

export const InventoryLevelSchema = z.object({
  variantId: z.string().min(1),
  availability: AvailabilitySchema,
  /** null when the platform does not expose exact counts. */
  quantityAvailable: z.number().int().nonnegative().nullable(),
});
export type InventoryLevel = z.infer<typeof InventoryLevelSchema>;

export const GetInventoryInputSchema = z.array(z.string().min(1)).min(1).max(100);
