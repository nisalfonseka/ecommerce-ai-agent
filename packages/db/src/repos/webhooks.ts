import { and, eq } from "drizzle-orm";
import type { Tx } from "../client";
import { stores, webhookEvents } from "../schema";

/**
 * Records a verified webhook once per (store, eventId). `isNew` is false for a redelivery;
 * `enqueuedAt` tells the caller whether the job was already sent (null means a previous attempt failed
 * before enqueueing, so the caller must enqueue again).
 */
export async function recordWebhookEvent(
  tx: Tx,
  tenantId: string,
  e: { storeId: string; eventId: string; type: string; payload: unknown },
): Promise<{ id: string; isNew: boolean; enqueuedAt: Date | null }> {
  const [inserted] = await tx
    .insert(webhookEvents)
    .values({ tenantId, storeId: e.storeId, eventId: e.eventId, type: e.type, payload: e.payload })
    .onConflictDoNothing()
    .returning({ id: webhookEvents.id, enqueuedAt: webhookEvents.enqueuedAt });
  if (inserted) return { id: inserted.id, isNew: true, enqueuedAt: inserted.enqueuedAt };
  const [existing] = await tx
    .select({ id: webhookEvents.id, enqueuedAt: webhookEvents.enqueuedAt })
    .from(webhookEvents)
    .where(and(eq(webhookEvents.storeId, e.storeId), eq(webhookEvents.eventId, e.eventId)));
  if (!existing) throw new Error("webhook event vanished after conflict");
  return { id: existing.id, isNew: false, enqueuedAt: existing.enqueuedAt };
}

export async function markWebhookEnqueued(tx: Tx, id: string): Promise<void> {
  await tx.update(webhookEvents).set({ enqueuedAt: new Date() }).where(eq(webhookEvents.id, id));
}

export async function markWebhookProcessed(tx: Tx, storeId: string, eventId: string): Promise<void> {
  await tx
    .update(webhookEvents)
    .set({ processedAt: new Date() })
    .where(and(eq(webhookEvents.storeId, storeId), eq(webhookEvents.eventId, eventId)));
}

export async function getWebhookEvent(
  tx: Tx,
  storeId: string,
  eventId: string,
): Promise<{ type: string; payload: unknown } | null> {
  const [row] = await tx
    .select({ type: webhookEvents.type, payload: webhookEvents.payload })
    .from(webhookEvents)
    .where(and(eq(webhookEvents.storeId, storeId), eq(webhookEvents.eventId, eventId)));
  return row ?? null;
}

/** Replaces the store's webhook secret (rotation). False when the store is not visible to this tenant. */
export async function setStoreWebhookSecret(tx: Tx, storeId: string, sealed: Buffer): Promise<boolean> {
  const updated = await tx
    .update(stores)
    .set({ webhookSecretSealed: sealed })
    .where(eq(stores.id, storeId))
    .returning({ id: stores.id });
  return updated.length > 0;
}
