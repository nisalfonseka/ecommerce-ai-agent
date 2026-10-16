import { and, desc, eq, gt, inArray } from "drizzle-orm";
import type { Tx } from "../client";
import { conversations, privacyExports, privacyRequests } from "../schema";

export type PrivacyRequestRow = typeof privacyRequests.$inferSelect;
export type PrivacyRequestType = "export" | "delete" | "offboard";
export type PrivacySubject =
  | { subjectHash: string; conversationId?: never }
  | { conversationId: string; subjectHash?: never };

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

/** Finds a subject only inside the caller's tenant-scoped transaction. */
export async function listPrivacySubjectConversations(tx: Tx, subject: PrivacySubject) {
  return tx
    .select()
    .from(conversations)
    .where(
      subject.subjectHash !== undefined
        ? eq(conversations.identityHash, subject.subjectHash)
        : eq(conversations.id, subject.conversationId),
    )
    .orderBy(conversations.createdAt, conversations.id);
}

/** Idempotent job output: retrying the same request replaces its still-private bundle. */
export async function putPrivacyExport(
  tx: Tx,
  tenantId: string,
  input: PrivacySubject & { requestId: string; payload: unknown; expiresAt: Date },
): Promise<void> {
  await tx
    .insert(privacyExports)
    .values({
      tenantId,
      requestId: input.requestId,
      subjectHash: input.subjectHash ?? null,
      conversationId: input.conversationId ?? null,
      payload: input.payload,
      expiresAt: input.expiresAt,
    })
    .onConflictDoUpdate({
      target: privacyExports.requestId,
      set: { payload: input.payload, expiresAt: input.expiresAt },
    });
}

/** One-time retrieval: the DELETE and payload return happen in the same statement. */
export async function takePrivacyExport(
  tx: Tx,
  requestId: string,
  now = new Date(),
): Promise<unknown | null> {
  const [row] = await tx
    .delete(privacyExports)
    .where(and(eq(privacyExports.requestId, requestId), gt(privacyExports.expiresAt, now)))
    .returning({ payload: privacyExports.payload });
  return row?.payload ?? null;
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
