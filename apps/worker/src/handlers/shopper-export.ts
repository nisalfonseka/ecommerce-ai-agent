import {
  finishPrivacyRequest,
  getPrivacyRequest,
  listPrivacySubjectConversations,
  putPrivacyExport,
  schema,
  withTenant,
} from "@ace/db";
import { JOBS } from "@ace/db/jobs";
import { asc, inArray } from "drizzle-orm";
import type { WorkerDeps, WorkerJob } from "../deps";
import { parsePayload } from "../job";

const DAY_MS = 24 * 60 * 60 * 1000;

/** A subject access bundle contains display data only: never model/tool payloads or internal traces. */
export async function handleShopperExport(
  deps: WorkerDeps,
  job: WorkerJob,
): Promise<Record<string, number> | undefined> {
  const payload = parsePayload(JOBS.shopperExport, job, deps.logger);
  if (!payload) return undefined;
  const subject = payload.subjectHash
    ? ({ subjectHash: payload.subjectHash } as const)
    : ({ conversationId: payload.conversationId ?? "" } as const);
  const now = deps.now();
  return withTenant(deps.db, payload.tenantId, async (tx) => {
    const request = await getPrivacyRequest(tx, payload.requestId);
    if (request?.type !== "export") return undefined;
    if (request.status === "completed") return request.counts as Record<string, number>;
    const conversations = await listPrivacySubjectConversations(tx, subject);
    const ids = conversations.map((conversation) => conversation.id);
    const messages =
      ids.length === 0
        ? []
        : await tx
            .select({
              conversationId: schema.messages.conversationId,
              display: schema.messages.display,
              createdAt: schema.messages.createdAt,
            })
            .from(schema.messages)
            .where(inArray(schema.messages.conversationId, ids))
            .orderBy(asc(schema.messages.createdAt), asc(schema.messages.id));
    const displayMessages = messages.filter((message) => message.display !== null);
    const handoffs =
      ids.length === 0
        ? []
        : await tx
            .select({
              conversationId: schema.handoffs.conversationId,
              reason: schema.handoffs.reason,
              summary: schema.handoffs.summary,
              status: schema.handoffs.status,
              createdAt: schema.handoffs.createdAt,
              resolvedAt: schema.handoffs.resolvedAt,
            })
            .from(schema.handoffs)
            .where(inArray(schema.handoffs.conversationId, ids));
    const consents =
      ids.length === 0
        ? []
        : await tx
            .select({
              conversationId: schema.consents.conversationId,
              noticeVersion: schema.consents.noticeVersion,
              noticeUrl: schema.consents.noticeUrl,
              createdAt: schema.consents.createdAt,
            })
            .from(schema.consents)
            .where(inArray(schema.consents.conversationId, ids));
    const verifications =
      ids.length === 0
        ? []
        : await tx
            .select({
              conversationId: schema.verifications.conversationId,
              channel: schema.verifications.channel,
              expiresAt: schema.verifications.expiresAt,
              consumedAt: schema.verifications.consumedAt,
              createdAt: schema.verifications.createdAt,
            })
            .from(schema.verifications)
            .where(inArray(schema.verifications.conversationId, ids));
    const bundle = {
      generatedAt: now,
      conversations: conversations.map((conversation) => ({
        id: conversation.id,
        channel: conversation.channel,
        status: conversation.status,
        createdAt: conversation.createdAt,
        lastMessageAt: conversation.lastMessageAt,
        messages: displayMessages.filter((row) => row.conversationId === conversation.id),
        handoffs: handoffs.filter((row) => row.conversationId === conversation.id),
        consents: consents.filter((row) => row.conversationId === conversation.id),
        verifications: verifications.filter((row) => row.conversationId === conversation.id),
      })),
    };
    const counts = {
      conversations: conversations.length,
      messages: displayMessages.length,
      handoffs: handoffs.length,
      consents: consents.length,
      verifications: verifications.length,
    };
    await putPrivacyExport(tx, payload.tenantId, {
      ...subject,
      requestId: payload.requestId,
      payload: bundle,
      expiresAt: new Date(now.getTime() + DAY_MS),
    });
    await finishPrivacyRequest(tx, payload.requestId, { status: "completed", counts }, now);
    deps.logger.info(
      { job: JOBS.shopperExport, tenantId: payload.tenantId, requestId: payload.requestId, counts },
      "privacy export completed",
    );
    return counts;
  });
}
