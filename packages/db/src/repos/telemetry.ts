import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Tx } from "../client";
import { redactDeep } from "../redact";
import { toolCalls, turnTraces, usageLedger } from "../schema";

export interface ToolCallInput {
  name: string;
  input: unknown;
  output: unknown;
  ok: boolean;
  errorCode?: string | null;
  ms: number;
}

export async function recordToolCalls(
  tx: Tx,
  tenantId: string,
  conversationId: string,
  turnId: string,
  calls: ToolCallInput[],
): Promise<void> {
  if (calls.length === 0) return;
  await tx.insert(toolCalls).values(
    calls.map((call) => ({
      tenantId,
      conversationId,
      turnId,
      name: call.name,
      inputRedacted: redactDeep(call.input),
      outputRedacted: redactDeep(call.output),
      ok: call.ok,
      errorCode: call.errorCode ?? null,
      ms: call.ms,
    })),
  );
}

export interface TurnRecord {
  conversationId: string;
  botId: string;
  turnId: string;
  model: string;
  promptVersion: string;
  inputTokens: number;
  outputTokens: number;
  costUsdMicros: number | null;
  latencyMs: number;
  toolNames: string[];
  outcomes: string[];
  regenerated: boolean;
  ungroundedCount: number;
  error: string | null;
}

/** Writes the turn trace (shopper-linked, short retention) and the usage row (billing, kept). */
export async function recordTurn(tx: Tx, tenantId: string, turn: TurnRecord): Promise<void> {
  const { botId, ...trace } = turn;
  await tx.insert(turnTraces).values({ tenantId, ...trace });
  await tx.insert(usageLedger).values({
    tenantId,
    botId,
    turnId: turn.turnId,
    model: turn.model,
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    costUsdMicros: turn.costUsdMicros,
  });
}

function monthBounds(now: Date): { start: Date; end: Date } {
  return {
    start: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
    end: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)),
  };
}

/** Spend for the bot in the UTC calendar month containing `now`, in micro-dollars. */
export async function monthToDateCostMicros(tx: Tx, botId: string, now: Date): Promise<number> {
  const { start, end } = monthBounds(now);
  const [row] = await tx
    .select({ total: sql<number>`coalesce(sum(${usageLedger.costUsdMicros}), 0)::int` })
    .from(usageLedger)
    .where(
      and(eq(usageLedger.botId, botId), gte(usageLedger.createdAt, start), lt(usageLedger.createdAt, end)),
    );
  return row?.total ?? 0;
}

/**
 * The tenant's usage for the month containing `now`. Conversation counts come from traces, which are kept
 * for 30 days, so they are exact only for recent months.
 */
export async function usageReport(
  tx: Tx,
  now: Date,
): Promise<{
  costUsdMicros: number;
  turns: number;
  conversations: number;
  avgCostPerConversationUsdMicros: number | null;
}> {
  const { start, end } = monthBounds(now);
  const [usage] = await tx
    .select({
      cost: sql<number>`coalesce(sum(${usageLedger.costUsdMicros}), 0)::int`,
      turns: sql<number>`count(*)::int`,
    })
    .from(usageLedger)
    .where(and(gte(usageLedger.createdAt, start), lt(usageLedger.createdAt, end)));
  const [traces] = await tx
    .select({ conversations: sql<number>`count(distinct ${turnTraces.conversationId})::int` })
    .from(turnTraces)
    .where(and(gte(turnTraces.createdAt, start), lt(turnTraces.createdAt, end)));
  const costUsdMicros = usage?.cost ?? 0;
  const conversations = traces?.conversations ?? 0;
  return {
    costUsdMicros,
    turns: usage?.turns ?? 0,
    conversations,
    avgCostPerConversationUsdMicros: conversations === 0 ? null : Math.round(costUsdMicros / conversations),
  };
}
