import type { CommerceProvider, VerifiedIdentity, WriteOptions } from "@ace/contracts";
import { createSession, type SessionState } from "./session";
import type { UiPart } from "./ui";

/** Server-side state for one turn. Built by the engine; the model can never set any of it. */
export interface ToolContext {
  readonly provider: CommerceProvider;
  readonly conversationId: string;
  readonly turnId: string;
  readonly identity: VerifiedIdentity | null;
  readonly session: SessionState;
  /** Host site's cart; tools replace it when they have to create a new one. */
  cartId: string | null;
  readonly ui: UiPart[];
  /** Minor-unit amounts read from the provider this turn; the grounding check allows only these. */
  readonly observedAmounts: Set<number>;
}

export interface CreateToolContextInput {
  provider: CommerceProvider;
  conversationId: string;
  turnId: string;
  identity?: VerifiedIdentity | null;
  session?: SessionState;
  cartId?: string | null;
}

export function createToolContext(input: CreateToolContextInput): ToolContext {
  return {
    provider: input.provider,
    conversationId: input.conversationId,
    turnId: input.turnId,
    identity: input.identity ?? null,
    session: input.session ?? createSession(),
    cartId: input.cartId ?? null,
    ui: [],
    observedAmounts: new Set(),
  };
}

/** Deterministic per tool call, so a retried turn replays instead of double-writing (ADR-002). */
export function writeKey(ctx: ToolContext, toolCallId: string): WriteOptions {
  return { idempotencyKey: `ace:${ctx.turnId}:${toolCallId}` };
}

function isMoney(value: unknown): value is { amount: number; currency: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { amount?: unknown }).amount === "number" &&
    typeof (value as { currency?: unknown }).currency === "string"
  );
}

export function observeMoney(ctx: ToolContext, value: unknown): void {
  if (isMoney(value)) {
    ctx.observedAmounts.add(value.amount);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) observeMoney(ctx, item);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) observeMoney(ctx, item);
  }
}
