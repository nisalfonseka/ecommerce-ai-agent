import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { ProductEvents } from "@medusajs/framework/utils";
import { notifyProducts, queryOf } from "../lib/product-events";

/** Product created/updated/deleted and variant updates (price, options) tell the engine to re-sync the product. */
export default async function productChanged({
  event,
  container,
}: SubscriberArgs<{ id: string }>): Promise<void> {
  const { id } = event.data;
  if (event.name === ProductEvents.PRODUCT_DELETED) {
    await notifyProducts(container, "product.deleted", [id]);
  } else if (event.name === ProductEvents.PRODUCT_VARIANT_UPDATED) {
    const {
      data: [variant],
    } = await queryOf(container).graph({
      entity: "product_variant",
      fields: ["id", "product_id"],
      filters: { id },
    });
    const productId = variant?.product_id;
    if (typeof productId === "string") await notifyProducts(container, "product.updated", [productId]);
  } else {
    await notifyProducts(container, "product.updated", [id]);
  }
}

export const config: SubscriberConfig = {
  event: [
    ProductEvents.PRODUCT_CREATED,
    ProductEvents.PRODUCT_UPDATED,
    ProductEvents.PRODUCT_DELETED,
    ProductEvents.PRODUCT_VARIANT_UPDATED,
  ],
};
