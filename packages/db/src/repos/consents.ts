import { desc, eq } from "drizzle-orm";
import type { Tx } from "../client";
import { consents } from "../schema";

export type ConsentRow = typeof consents.$inferSelect;

/** Idempotent per (conversation, notice version). True when this call recorded it, false for a repeat. */
export async function recordConsent(
  tx: Tx,
  tenantId: string,
  input: { conversationId: string; noticeVersion: string; noticeUrl?: string | null },
): Promise<boolean> {
  const rows = await tx
    .insert(consents)
    .values({
      tenantId,
      conversationId: input.conversationId,
      noticeVersion: input.noticeVersion,
      noticeUrl: input.noticeUrl ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: consents.id });
  return rows.length > 0;
}

export async function getLatestConsent(tx: Tx, conversationId: string): Promise<ConsentRow | null> {
  const [row] = await tx
    .select()
    .from(consents)
    .where(eq(consents.conversationId, conversationId))
    .orderBy(desc(consents.createdAt))
    .limit(1);
  return row ?? null;
}
