import type { HandoffReason } from "@ace/agent";
import {
  appendMessages,
  createHandoff,
  type Db,
  getHandoff,
  loadMessages,
  redactPii,
  schema,
  transitionHandoff,
  withTenant,
} from "@ace/db";
import { JOBS, type JobQueue } from "@ace/db/jobs";
import { and, eq, isNull, lt, or } from "drizzle-orm";

export interface HandoffServiceDeps {
  db: Db;
  jobs: JobQueue;
  now?: () => Date;
}

export interface OpenHandoffInput {
  reason: HandoffReason;
  summary: string;
}

export async function openHandoff(
  deps: HandoffServiceDeps,
  ctx: { tenantId: string; conversationId: string },
  input: OpenHandoffInput,
): Promise<{ id: string; created: boolean }> {
  const now = deps.now?.() ?? new Date();
  const opened = await withTenant(deps.db, ctx.tenantId, async (tx) => {
    const result = await createHandoff(tx, ctx.tenantId, {
      conversationId: ctx.conversationId,
      reason: input.reason,
      summary: redactPii(input.summary),
    });
    if (result.created) {
      await tx
        .update(schema.conversations)
        .set({ status: "handoff", handoffOpenedAt: now })
        .where(eq(schema.conversations.id, ctx.conversationId));
    }
    return result;
  });
  if (opened.created) {
    await deps.jobs.send(JOBS.handoffNotify, { tenantId: ctx.tenantId, handoffId: opened.handoff.id });
  }
  return { id: opened.handoff.id, created: opened.created };
}

export async function claimHandoff(
  deps: HandoffServiceDeps,
  tenantId: string,
  handoffId: string,
  staffName: string,
): Promise<"claimed" | "already_claimed" | "not_found"> {
  return withTenant(deps.db, tenantId, async (tx) => {
    const result = await transitionHandoff(tx, handoffId, { to: "claimed", claimedBy: staffName });
    if (result.ok) return "claimed";
    if (result.reason === "not_found") return "not_found";
    return "already_claimed";
  });
}

export async function staffReply(
  deps: HandoffServiceDeps,
  tenantId: string,
  handoffId: string,
  staffName: string,
  text: string,
): Promise<"sent" | "not_found" | "not_claimed_by_you"> {
  return withTenant(deps.db, tenantId, async (tx) => {
    const handoff = await getHandoff(tx, handoffId);
    if (!handoff) return "not_found";
    if (handoff.status !== "claimed" || handoff.claimedBy !== staffName) return "not_claimed_by_you";
    const stored = await loadMessages(tx, handoff.conversationId);
    await appendMessages(tx, tenantId, handoff.conversationId, stored.nextSeq, [
      {
        kind: "staff",
        payload: { role: "assistant", content: text },
        display: { role: "staff", label: "Team", text },
      },
    ]);
    return "sent";
  });
}

async function finishHandoff(
  deps: HandoffServiceDeps,
  tenantId: string,
  handoffId: string,
  conversationStatus: "open" | "closed",
): Promise<void> {
  const now = deps.now?.() ?? new Date();
  await withTenant(deps.db, tenantId, async (tx) => {
    const handoff = await getHandoff(tx, handoffId);
    if (!handoff) return;
    const transitioned = await transitionHandoff(tx, handoffId, { to: "resolved" }, now);
    if (!transitioned.ok) return;
    const rows = await tx
      .update(schema.conversations)
      .set({ status: conversationStatus, handoffOpenedAt: null })
      .where(
        and(
          eq(schema.conversations.id, handoff.conversationId),
          or(isNull(schema.conversations.busyUntil), lt(schema.conversations.busyUntil, now)),
        ),
      )
      .returning({ id: schema.conversations.id });
    if (rows.length === 0) throw new Error("conversation is busy");
  });
}

export async function handBack(deps: HandoffServiceDeps, tenantId: string, handoffId: string): Promise<void> {
  await finishHandoff(deps, tenantId, handoffId, "open");
}

export async function resolveHandoff(
  deps: HandoffServiceDeps,
  tenantId: string,
  handoffId: string,
): Promise<void> {
  await finishHandoff(deps, tenantId, handoffId, "closed");
}
