import {
  finishPrivacyRequest,
  getPrivacyRequest,
  listPrivacySubjectConversations,
  SHOPPER_DATA_TABLES,
  schema,
  type Tx,
  withTenant,
} from "@ace/db";
import { JOBS } from "@ace/db/jobs";
import { count, eq, inArray, or, type SQL, sql } from "drizzle-orm";
import type { WorkerDeps, WorkerJob } from "../deps";
import { parsePayload } from "../job";

async function countForConversations(tx: Tx, ids: string[]) {
  if (ids.length === 0) {
    return { messages: 0, tool_calls: 0, turn_traces: 0, handoffs: 0, verifications: 0, consents: 0 };
  }
  return {
    messages: Number(
      (
        await tx
          .select({ n: count() })
          .from(schema.messages)
          .where(inArray(schema.messages.conversationId, ids))
      )[0]?.n ?? 0,
    ),
    tool_calls: Number(
      (
        await tx
          .select({ n: count() })
          .from(schema.toolCalls)
          .where(inArray(schema.toolCalls.conversationId, ids))
      )[0]?.n ?? 0,
    ),
    turn_traces: Number(
      (
        await tx
          .select({ n: count() })
          .from(schema.turnTraces)
          .where(inArray(schema.turnTraces.conversationId, ids))
      )[0]?.n ?? 0,
    ),
    handoffs: Number(
      (
        await tx
          .select({ n: count() })
          .from(schema.handoffs)
          .where(inArray(schema.handoffs.conversationId, ids))
      )[0]?.n ?? 0,
    ),
    verifications: Number(
      (
        await tx
          .select({ n: count() })
          .from(schema.verifications)
          .where(inArray(schema.verifications.conversationId, ids))
      )[0]?.n ?? 0,
    ),
    consents: Number(
      (
        await tx
          .select({ n: count() })
          .from(schema.consents)
          .where(inArray(schema.consents.conversationId, ids))
      )[0]?.n ?? 0,
    ),
  };
}

/** Deletes one HMAC/UUID-selected subject. Conversation cascades remove every attached shopper-data row. */
export async function handleShopperDelete(
  deps: WorkerDeps,
  job: WorkerJob,
): Promise<Record<string, number> | undefined> {
  const payload = parsePayload(JOBS.shopperDelete, job, deps.logger);
  if (!payload) return undefined;
  const subject = payload.subjectHash
    ? ({ subjectHash: payload.subjectHash } as const)
    : ({ conversationId: payload.conversationId ?? "" } as const);
  const now = deps.now();
  return withTenant(deps.db, payload.tenantId, async (tx) => {
    const request = await getPrivacyRequest(tx, payload.requestId);
    if (request?.type !== "delete") return undefined;
    if (request.status === "completed") return request.counts as Record<string, number>;
    const conversations = await listPrivacySubjectConversations(tx, subject);
    const ids = conversations.map((conversation) => conversation.id);
    const subjectHashes = [
      ...new Set(
        conversations
          .map((conversation) => conversation.identityHash)
          .filter((value): value is string => value !== null),
      ),
    ];
    const counts: Record<string, number> = {
      conversations: ids.length,
      ...(await countForConversations(tx, ids)),
    };
    let exportWhere: SQL =
      payload.subjectHash !== undefined
        ? eq(schema.privacyExports.subjectHash, payload.subjectHash)
        : eq(schema.privacyExports.conversationId, payload.conversationId ?? "");
    if (ids.length > 0) {
      exportWhere =
        or(
          exportWhere,
          inArray(schema.privacyExports.conversationId, ids),
          subjectHashes.length > 0 ? inArray(schema.privacyExports.subjectHash, subjectHashes) : undefined,
        ) ?? exportWhere;
    }
    counts.privacy_exports = Number(
      (await tx.select({ n: count() }).from(schema.privacyExports).where(exportWhere))[0]?.n ?? 0,
    );
    await tx.delete(schema.privacyExports).where(exportWhere);
    if (ids.length > 0) await tx.delete(schema.conversations).where(inArray(schema.conversations.id, ids));
    await finishPrivacyRequest(tx, payload.requestId, { status: "completed", counts }, now);
    deps.logger.info(
      { job: JOBS.shopperDelete, tenantId: payload.tenantId, requestId: payload.requestId, counts },
      "shopper deletion completed",
    );
    return counts;
  });
}

/** Deletes all shopper data under one tenant while receipts, merchant configuration and billing facts remain. */
export async function handleTenantOffboard(
  deps: WorkerDeps,
  job: WorkerJob,
): Promise<Record<string, number> | undefined> {
  const payload = parsePayload(JOBS.tenantOffboard, job, deps.logger);
  if (!payload) return undefined;
  const now = deps.now();
  return withTenant(deps.db, payload.tenantId, async (tx) => {
    const request = await getPrivacyRequest(tx, payload.requestId);
    if (request?.type !== "offboard") return undefined;
    if (request.status === "completed") return request.counts as Record<string, number>;
    const counts: Record<string, number> = {};
    for (const { table } of SHOPPER_DATA_TABLES) {
      const name = sql.identifier(table);
      const result = await tx.execute<{ n: number }>(sql`select count(*)::int as n from ${name}`);
      counts[table] = result.rows[0]?.n ?? 0;
    }
    const ordered = [...SHOPPER_DATA_TABLES].sort(
      (left, right) => Number(left.table === "conversations") - Number(right.table === "conversations"),
    );
    for (const { table } of ordered) await tx.execute(sql`delete from ${sql.identifier(table)}`);
    await finishPrivacyRequest(tx, payload.requestId, { status: "completed", counts }, now);
    deps.logger.info(
      { job: JOBS.tenantOffboard, tenantId: payload.tenantId, requestId: payload.requestId, counts },
      "tenant shopper data offboarded",
    );
    return counts;
  });
}
