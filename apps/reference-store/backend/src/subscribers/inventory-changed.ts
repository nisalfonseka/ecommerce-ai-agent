import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { InventoryEvents } from "@medusajs/framework/utils";
import { productIdsForInventoryLevel } from "../lib/inventory-products";
import { notifyProducts, queryOf } from "../lib/product-events";

/** A stock level changed: every product that sells this inventory item needs its availability re-read. */
export default async function inventoryChanged({
  event,
  container,
}: SubscriberArgs<{ id: string }>): Promise<void> {
  const productIds = await productIdsForInventoryLevel(queryOf(container), event.data.id);
  await notifyProducts(container, "inventory.updated", productIds);
}

export const config: SubscriberConfig = {
  event: [InventoryEvents.INVENTORY_LEVEL_UPDATED, InventoryEvents.INVENTORY_LEVEL_CREATED],
};
