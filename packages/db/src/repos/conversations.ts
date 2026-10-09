import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import type { Tx } from "../client";
import { conversations, messages } from "../schema";

export type ConversationRow = typeof conversations.$inferSelect;

export interface MessageInput {
  kind: "model" | "action";
  /** For "model": an AI SDK ModelMessage. For "action": the action event. Stored as JSON. */
  payload: unknown;
  /** What the shopper sees on reload; omit for tool steps. */
  display?: unknown;
}

export async function createConversation(
  tx: Tx,
  tenantId: string,
  input: { botId: string; visitorId: string; session: unknown; channel?: string; cartId?: string | null },
): Promise<ConversationRow> {
  const [row] = await tx
    .insert(conversations)
    .values({
      tenantId,
      botId: input.botId,
      visitorId: input.visitorId,
      session: input.session,
      channel: input.channel ?? "web",
      cartId: input.cartId ?? null,
    })
    .returning();
  if (!row) throw new Error("conversation insert returned no row");
  return row;
}

export async function getConversation(tx: Tx, conversationId: string): Promise<ConversationRow | null> {
  const [row] = await tx.select().from(conversations).where(eq(conversations.id, conversationId));
  return row ?? null;
}

/**
 * Claims the conversation for one turn until now + leaseMs. Returns null when another turn holds it.
 * Commit before the slow model call so a concurrent request sees the lease.
 */
export async function acquireTurnLease(
  tx: Tx,
  conversationId: string,
  leaseMs: number,
): Promise<ConversationRow | null> {
  const [row] = await tx
    .update(conversations)
    .set({ busyUntil: sql`now() + ${`${leaseMs} milliseconds`}::interval` })
    .where(
      and(
        eq(conversations.id, conversationId),
        sql`(${conversations.busyUntil} is null or ${conversations.busyUntil} < now())`,
      ),
    )
    .returning();
  return row ?? null;
}

export async function releaseLease(tx: Tx, conversationId: string): Promise<void> {
  await tx.update(conversations).set({ busyUntil: null }).where(eq(conversations.id, conversationId));
}

export async function saveSessionAndRelease(
  tx: Tx,
  conversationId: string,
  input: { session: unknown; cartId: string | null },
): Promise<void> {
  await tx
    .update(conversations)
    .set({ session: input.session, cartId: input.cartId, busyUntil: null, lastMessageAt: new Date() })
    .where(eq(conversations.id, conversationId));
}

export async function loadMessages(
  tx: Tx,
  conversationId: string,
): Promise<{ rows: { seq: number; kind: string; payload: unknown }[]; nextSeq: number }> {
  const rows = await tx
    .select({ seq: messages.seq, kind: messages.kind, payload: messages.payload })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(asc(messages.seq));
  return { rows, nextSeq: (rows.at(-1)?.seq ?? -1) + 1 };
}

/** Inserts rows at startSeq, startSeq + 1, …; a racing writer hits the (conversation, seq) unique key. */
export async function appendMessages(
  tx: Tx,
  tenantId: string,
  conversationId: string,
  startSeq: number,
  rows: MessageInput[],
): Promise<void> {
  if (rows.length === 0) return;
  await tx.insert(messages).values(
    rows.map((row, index) => ({
      tenantId,
      conversationId,
      seq: startSeq + index,
      kind: row.kind,
      payload: row.payload,
      display: row.display ?? null,
    })),
  );
}

export async function listDisplay(tx: Tx, conversationId: string): Promise<unknown[]> {
  const rows = await tx
    .select({ display: messages.display })
    .from(messages)
    .where(and(eq(messages.conversationId, conversationId), isNotNull(messages.display)))
    .orderBy(asc(messages.seq));
  return rows.map((row) => row.display);
}
