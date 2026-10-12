import { and, count, desc, eq, gt, gte, isNull, sql } from "drizzle-orm";
import type { Tx } from "../client";
import { verifications } from "../schema";

export type VerificationRow = typeof verifications.$inferSelect;

export interface VerificationInput {
  conversationId: string;
  channel: "sms" | "email";
  /** HMAC of the normalised destination; never the destination itself. */
  destinationHash: string;
  /** HMAC(code ‖ salt); never the code. */
  codeHash: string;
  salt: string;
  expiresAt: Date;
}

/**
 * Stores a new code and invalidates every earlier unconsumed code of the conversation in the same
 * transaction, so a shopper has one live code at a time. The advisory lock serialises concurrent starts for
 * one conversation (the partial unique index is the backstop).
 */
export async function createVerification(
  tx: Tx,
  tenantId: string,
  input: VerificationInput,
): Promise<VerificationRow> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`verification:${input.conversationId}`}, 0))`,
  );
  await tx
    .update(verifications)
    .set({ consumedAt: new Date() })
    .where(and(eq(verifications.conversationId, input.conversationId), isNull(verifications.consumedAt)));
  const [row] = await tx
    .insert(verifications)
    .values({ tenantId, ...input })
    .returning();
  if (!row) throw new Error("verification insert returned no row");
  return row;
}

/** The conversation's live code: unconsumed and not expired at `now`. The caller checks `attempts`. */
export async function getPendingVerification(
  tx: Tx,
  conversationId: string,
  now: Date,
): Promise<VerificationRow | null> {
  const [row] = await tx
    .select()
    .from(verifications)
    .where(
      and(
        eq(verifications.conversationId, conversationId),
        isNull(verifications.consumedAt),
        gt(verifications.expiresAt, now),
      ),
    )
    .orderBy(desc(verifications.createdAt))
    .limit(1);
  return row ?? null;
}

/** Counts a wrong attempt atomically. Returns the new total, or null when the code is gone or consumed. */
export async function incrementAttempts(tx: Tx, id: string): Promise<number | null> {
  const [row] = await tx
    .update(verifications)
    .set({ attempts: sql`${verifications.attempts} + 1` })
    .where(and(eq(verifications.id, id), isNull(verifications.consumedAt)))
    .returning({ attempts: verifications.attempts });
  return row?.attempts ?? null;
}

/** Single use: true for exactly one caller, false for a replay, an expired code or an unknown id. */
export async function consumeVerification(tx: Tx, id: string, now: Date): Promise<boolean> {
  const rows = await tx
    .update(verifications)
    .set({ consumedAt: now })
    .where(and(eq(verifications.id, id), isNull(verifications.consumedAt), gt(verifications.expiresAt, now)))
    .returning({ id: verifications.id });
  return rows.length > 0;
}

/**
 * Codes started since `since`, for the send limits. Replaced and consumed codes count: a start is a start.
 * The filters combine with AND; at least one is required so a limit can never silently count a whole tenant.
 */
export async function countRecentStarts(
  tx: Tx,
  filter: { conversationId?: string; destinationHash?: string; since: Date },
): Promise<number> {
  if (filter.conversationId === undefined && filter.destinationHash === undefined) {
    throw new Error("countRecentStarts needs a conversationId or destinationHash");
  }
  const conditions = [gte(verifications.createdAt, filter.since)];
  if (filter.conversationId !== undefined)
    conditions.push(eq(verifications.conversationId, filter.conversationId));
  if (filter.destinationHash !== undefined) {
    conditions.push(eq(verifications.destinationHash, filter.destinationHash));
  }
  const [row] = await tx
    .select({ n: count() })
    .from(verifications)
    .where(and(...conditions));
  return row?.n ?? 0;
}
