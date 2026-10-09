import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { orderWebhookPayload, sendAceWebhook } from "../lib/ace-webhook";

/** Tells the assistant engine about new orders (attribution). Off unless configured. */
export default async function orderPlaced({
  event,
  container,
}: SubscriberArgs<{ id: string }>): Promise<void> {
  const url = process.env.ACE_WEBHOOK_URL;
  const secret = process.env.ACE_WEBHOOK_SECRET;
  if (!url || !secret) return;
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const {
    data: [order],
  } = await query.graph({
    entity: "order",
    fields: ["id", "display_id", "total", "currency_code", "created_at", "metadata"],
    filters: { id: event.data.id },
  });
  if (!order) return;
  try {
    await sendAceWebhook(orderWebhookPayload(order), { url, secret });
  } catch (error) {
    logger.warn(
      `ace webhook for ${order.id} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export const config: SubscriberConfig = { event: "order.placed" };
