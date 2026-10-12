import { and, desc, eq, inArray } from "drizzle-orm";
import type { Tx } from "../client";
import { privacyRequests } from "../schema";

export type PrivacyRequestRow = typeof privacyRequests.$inferSelect;
export type PrivacyRequestType = "export" | "delete" | "offboard";

/** Starts a receipt in 'pending'. `subjectHash` is the data subject's identity_hash, or null. */
export async function createPrivacyRequest(
  tx: Tx,
  tenantId: string,
  input: { type: PrivacyRequestType; subjectHash: string | null },
): Promise<PrivacyRequestRow> {
  const [row] = await tx
    .insert(privacyRequests)
    .values({ tenantId, type: input.type, subjectHash: input.subjectHash })
    .returning();
  if (!row) throw new Error("privacy request insert returned no row");
  return row;
}

export async function getPrivacyRequest(tx: Tx, id: string): Promise<PrivacyRequestRow | null> {
  const [row] = await tx.select().from(privacyRequests).where(eq(privacyRequests.id, id));
  return row ?? null;
}

/** Newest first. Callers that expose receipts must leave `subjectHash` out. */
export async function listPrivacyRequests(tx: Tx, limit = 50): Promise<PrivacyRequestRow[]> {
  return tx
    .select()
    .from(privacyRequests)
    .orderBy(desc(privacyRequests.createdAt), desc(privacyRequests.id))
    .limit(Math.min(Math.max(limit, 1), 200));
}

/** Closes a pending or running request with its per-table row counts. False when it was already closed. */
export async function finishPrivacyRequest(
  tx: Tx,
  id: string,
  result: { status: "completed" | "failed"; counts: Record<string, number> },
  now: Date = new Date(),
): Promise<boolean> {
  const rows = await tx
    .update(privacyRequests)
    .set({ status: result.status, counts: result.counts, completedAt: now })
    .where(and(eq(privacyRequests.id, id), inArray(privacyRequests.status, ["pending", "running"])))
    .returning({ id: privacyRequests.id });
  return rows.length > 0;
}
