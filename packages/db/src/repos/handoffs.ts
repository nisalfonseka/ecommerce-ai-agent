import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Tx } from "../client";
import { handoffs } from "../schema";

/**
 * What every handoff read returns. The sealed contact is deliberately not a column here: a row that travels
 * through staff API code and logs must not carry it, so the one reader is getHandoffContactSealed.
 */
export interface HandoffRow {
  id: string;
  tenantId: string;
  conversationId: string;
  reason: string;
  summary: string;
  status: string;
  claimedBy: string | null;
  /** A contact was left for staff; read it with getHandoffContactSealed. */
  hasContact: boolean;
  notifiedAt: Date | null;
  resolvedAt: Date | null;
  createdAt: Date;
}
export type HandoffStatus = "open" | "claimed" | "resolved";

const HANDOFF_COLUMNS = {
  id: handoffs.id,
  tenantId: handoffs.tenantId,
  conversationId: handoffs.conversationId,
  reason: handoffs.reason,
  summary: handoffs.summary,
  status: handoffs.status,
  claimedBy: handoffs.claimedBy,
  hasContact: sql<boolean>`${handoffs.contactSealed} is not null`,
  notifiedAt: handoffs.notifiedAt,
  resolvedAt: handoffs.resolvedAt,
  createdAt: handoffs.createdAt,
};

export interface HandoffInput {
  conversationId: string;
  reason: string;
  /** Already redacted by the caller (redactPii); this package stores it as given. */
  summary: string;
  /** sealSecret() output for a contact the shopper left for staff. */
  contactSealed?: Buffer | null;
}

export async function getHandoff(tx: Tx, id: string): Promise<HandoffRow | null> {
  const [row] = await tx.select(HANDOFF_COLUMNS).from(handoffs).where(eq(handoffs.id, id));
  return row ?? null;
}

/** sealSecret() output for the contact the shopper left, or null. The only reader of `contact_sealed`. */
export async function getHandoffContactSealed(tx: Tx, id: string): Promise<Buffer | null> {
  const [row] = await tx.select({ sealed: handoffs.contactSealed }).from(handoffs).where(eq(handoffs.id, id));
  return row?.sealed ?? null;
}

/** The conversation's unresolved handoff, if any (there is at most one: see handoffs_one_active). */
export async function getActiveHandoff(tx: Tx, conversationId: string): Promise<HandoffRow | null> {
  const [row] = await tx
    .select(HANDOFF_COLUMNS)
    .from(handoffs)
    .where(and(eq(handoffs.conversationId, conversationId), inArray(handoffs.status, ["open", "claimed"])));
  return row ?? null;
}

/**
 * Opens a handoff once per conversation: while one is unresolved a second call returns it with
 * `created: false` and changes nothing, so a retried turn or a double click cannot open two.
 */
export async function createHandoff(
  tx: Tx,
  tenantId: string,
  input: HandoffInput,
): Promise<{ handoff: HandoffRow; created: boolean }> {
  // A handoff resolved between the conflict and the read leaves nothing to return; insert again then.
  for (let attempt = 0; attempt < 3; attempt++) {
    const [inserted] = await tx
      .insert(handoffs)
      .values({
        tenantId,
        conversationId: input.conversationId,
        reason: input.reason,
        summary: input.summary,
        contactSealed: input.contactSealed ?? null,
      })
      .onConflictDoNothing()
      .returning(HANDOFF_COLUMNS);
    if (inserted) return { handoff: inserted, created: true };
    const existing = await getActiveHandoff(tx, input.conversationId);
    if (existing) return { handoff: existing, created: false };
  }
  throw new Error("handoff insert kept conflicting with a handoff that is no longer active");
}

export type HandoffTransition = { to: "claimed"; claimedBy: string } | { to: "resolved" };

export type HandoffTransitionResult =
  | { ok: true; handoff: HandoffRow }
  /** Unknown id, or a handoff that belongs to another tenant (the same answer by design). */
  | { ok: false; reason: "not_found" }
  /** The handoff is not in a state this transition may start from; `status` is what it is now. */
  | { ok: false; reason: "conflict"; status: HandoffStatus };

/**
 * open → claimed → resolved, or open → resolved. One UPDATE guarded by the expected state, so two staff
 * claiming at once resolve to one winner and a repeat or backwards move changes nothing. Normal conflicts are
 * returned, not thrown.
 */
export async function transitionHandoff(
  tx: Tx,
  id: string,
  transition: HandoffTransition,
  now: Date = new Date(),
): Promise<HandoffTransitionResult> {
  let from: HandoffStatus[];
  let set: Partial<typeof handoffs.$inferInsert>;
  if (transition.to === "claimed") {
    if (transition.claimedBy.trim() === "") throw new Error("claimedBy is required to claim a handoff");
    from = ["open"];
    set = { status: "claimed", claimedBy: transition.claimedBy };
  } else {
    from = ["open", "claimed"];
    set = { status: "resolved", resolvedAt: now };
  }
  const [row] = await tx
    .update(handoffs)
    .set(set)
    .where(and(eq(handoffs.id, id), inArray(handoffs.status, from)))
    .returning(HANDOFF_COLUMNS);
  if (row) return { ok: true, handoff: row };
  const [current] = await tx.select({ status: handoffs.status }).from(handoffs).where(eq(handoffs.id, id));
  if (!current) return { ok: false, reason: "not_found" };
  return { ok: false, reason: "conflict", status: current.status as HandoffStatus };
}

/** Marks the alert as sent. True for exactly one caller, so a retried job sends one email per handoff. */
export async function markHandoffNotified(tx: Tx, id: string, now: Date): Promise<boolean> {
  const rows = await tx
    .update(handoffs)
    .set({ notifiedAt: now })
    .where(and(eq(handoffs.id, id), isNull(handoffs.notifiedAt)))
    .returning({ id: handoffs.id });
  return rows.length > 0;
}

/** The staff inbox: newest first, optionally limited to some statuses. */
export async function listHandoffs(
  tx: Tx,
  options: { status?: HandoffStatus[]; limit?: number },
): Promise<HandoffRow[]> {
  const where =
    options.status && options.status.length > 0 ? inArray(handoffs.status, options.status) : undefined;
  return tx
    .select(HANDOFF_COLUMNS)
    .from(handoffs)
    .where(where)
    .orderBy(desc(handoffs.createdAt), desc(handoffs.id))
    .limit(Math.min(Math.max(options.limit ?? 50, 1), 200));
}
