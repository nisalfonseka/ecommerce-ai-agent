import type { MedusaContainer } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { type ProductEventType, productWebhookPayload, sendAceWebhook } from "./ace-webhook";
import type { GraphQuery } from "./inventory-products";

/** Off unless ACE_WEBHOOK_URL and ACE_WEBHOOK_SECRET are set. A failed send is logged, never thrown. */
export async function notifyProducts(
  container: MedusaContainer,
  type: ProductEventType,
  productIds: string[],
): Promise<void> {
  const url = process.env.ACE_WEBHOOK_URL;
  const secret = process.env.ACE_WEBHOOK_SECRET;
  if (!url || !secret) return;
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  for (const productId of productIds) {
    try {
      await sendAceWebhook(productWebhookPayload(type, productId), { url, secret });
    } catch (error) {
      logger.warn(
        `ace webhook ${type} for ${productId} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

export function queryOf(container: MedusaContainer): GraphQuery {
  return container.resolve(ContainerRegistrationKeys.QUERY) as unknown as GraphQuery;
}
