import { ATTRIBUTION_ATTRIBUTE, MoneySchema } from "@ace/contracts";
import {
  getWebhookEvent,
  markWebhookProcessed,
  schema,
  type Tx,
  upsertAttributedOrder,
  withTenant,
} from "@ace/db";
import { JOBS } from "@ace/db/jobs";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { WorkerDeps, WorkerJob } from "../deps";
import { parsePayload } from "../job";

/** The fields of a stored ACE order.placed webhook (validated at ingress) that attribution reads. */
const StoredOrderEvent = z.object({
  orderId: z.string().min(1),
  orderNumber: z.string().min(1),
  total: MoneySchema,
  placedAt: z.iso.datetime(),
  attributes: z.record(z.string(), z.string()),
});

/**
 * The conversation id only counts when it names a conversation of this tenant (RLS) whose bot serves this
 * store. Anything else (absent, malformed, another tenant's or store's) is stored as null.
 */
async function ownConversation(
  tx: Tx,
  storeId: string,
  candidate: string | undefined,
): Promise<string | null> {
  if (candidate === undefined || !z.uuid().safeParse(candidate).success) return null;
  const [row] = await tx
    .select({ id: schema.conversations.id })
    .from(schema.conversations)
    .innerJoin(schema.bots, eq(schema.bots.id, schema.conversations.botId))
    .where(and(eq(schema.conversations.id, candidate), eq(schema.bots.storeId, storeId)));
  return row?.id ?? null;
}

/** Reads the recorded webhook event, upserts its attributed order and marks the event processed, in one transaction. */
export async function handleOrderPlaced(deps: WorkerDeps, job: WorkerJob): Promise<void> {
  const payload = parsePayload(JOBS.orderPlaced, job, deps.logger);
  if (!payload) return;
  const { tenantId, storeId, eventId } = payload;
  const outcome = await withTenant(deps.db, tenantId, async (tx) => {
    const event = await getWebhookEvent(tx, storeId, eventId);
    if (!event) return "missing";
    const order = StoredOrderEvent.safeParse(event.payload);
    if (!order.success) return "invalid";
    const conversationId = await ownConversation(tx, storeId, order.data.attributes[ATTRIBUTION_ATTRIBUTE]);
    await upsertAttributedOrder(tx, {
      tenantId,
      storeId,
      orderId: order.data.orderId,
      orderNumber: order.data.orderNumber,
      conversationId,
      totalAmount: order.data.total.amount,
      currency: order.data.total.currency,
      placedAt: new Date(order.data.placedAt),
    });
    await markWebhookProcessed(tx, storeId, eventId);
    return conversationId ? "chat_assisted" : "unassisted";
  });
  // Ids and the outcome only: the event payload is never logged.
  const level = outcome === "missing" || outcome === "invalid" ? "warn" : "info";
  deps.logger[level](
    { job: JOBS.orderPlaced, jobId: job.id, tenantId, storeId, outcome },
    "order attributed",
  );
}
