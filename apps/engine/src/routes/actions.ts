import { ACTION_TOOLS, ALL_TOOLS, createToolContext, isToolAvailable } from "@ace/agent";
import { CodDetailsSchema, MAX_LINE_QUANTITY } from "@ace/contracts";
import {
  appendMessages,
  loadMessages,
  recordToolCalls,
  releaseLease,
  saveSessionAndRelease,
  withTenant,
} from "@ace/db";
import type { Hono } from "hono";
import { z } from "zod";
import type { WidgetEnv } from "../auth/widget";
import { codPolicy, parseSession, parseStoreFacts } from "../bot-config";
import { clientIp } from "../client-ip";
import { openHandoff } from "../handoff/service";
import { errorResponse } from "../http-errors";
import { currentIdentity } from "../identity/conversation-identity";
import { confirmVerification, type OtpDeps, startVerification } from "../identity/otp";
import { leaseExistingConversation, type TurnDeps, TurnError } from "../turn";

/**
 * Card buttons only; anything else (refunds, discounts) does not exist here (AGENTS.md rule 8). The COD form
 * and its Confirm button live only here: the model has no tool that places an order (ADR-007).
 */
const ACTION_INPUTS = {
  add_to_cart: z.object({
    variantId: z.string().min(1).max(200),
    quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY),
  }),
  update_cart_line: z.object({
    lineId: z.string().min(1).max(200),
    quantity: z.number().int().min(0).max(MAX_LINE_QUANTITY),
  }),
  view_cart: z.object({}),
  start_checkout: z.object({}),
  cod_quote: CodDetailsSchema,
  place_cod_order: z.object({}),
} as const;

const RUNNABLE = [...ALL_TOOLS, ...ACTION_TOOLS];

const VERIFICATION_INPUTS = {
  verify_start: z.object({ channel: z.enum(["sms", "email"]), destination: z.string().min(1).max(254) }),
  verify_confirm: z.object({ code: z.string().max(32) }),
} as const;

const HandoffActionInput = z.strictObject({ reason: z.enum(["tool_failure", "not_sure"]) });

type ActionType = keyof typeof ACTION_INPUTS;
type VerificationActionType = keyof typeof VERIFICATION_INPUTS;

export interface ActionDeps extends TurnDeps {
  otp: OtpDeps;
  trustProxyHops?: number;
}

const ActionBodySchema = z.object({
  conversationId: z.uuid(),
  conversationToken: z.string().max(512),
  /** Client-generated; the idempotency key, so a double click applies once. */
  actionId: z.uuid(),
  cartId: z.string().min(1).max(200).optional(),
  input: z.unknown(),
});

function isActionType(value: string): value is ActionType {
  return Object.hasOwn(ACTION_INPUTS, value);
}

function isVerificationActionType(value: string): value is VerificationActionType {
  return Object.hasOwn(VERIFICATION_INPUTS, value);
}

function remoteAddress(env: unknown): string {
  const incoming = (env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? "unknown";
}

/**
 * POST /v1/actions/:type: deterministic card actions (spec J7). They run the same tool code with the same
 * ToolContext as a chat turn, but no model. The outcome is stored as an "action" message so the next turn
 * knows about it.
 */
export function registerActionRoutes(app: Hono<WidgetEnv>, deps: ActionDeps): void {
  app.post("/v1/actions/:type", async (c) => {
    const type = c.req.param("type");
    if (type === "request_handoff") {
      const body = ActionBodySchema.safeParse(await c.req.json().catch(() => null));
      const input = body.success ? HandoffActionInput.safeParse(body.data.input) : null;
      if (!body.success || !input?.success) {
        return errorResponse(c, 400, "invalid_input", "Invalid handoff request.");
      }
      if (!deps.jobs) return errorResponse(c, 503, "unavailable", "Human support is unavailable.");
      const { tenantId } = c.var.widget;
      let prepared: Awaited<ReturnType<typeof leaseExistingConversation>>;
      try {
        prepared = await leaseExistingConversation(
          deps,
          c.var.widget,
          body.data.conversationId,
          body.data.conversationToken,
        );
      } catch (error) {
        if (error instanceof TurnError) return errorResponse(c, error.status, error.code, error.message);
        throw error;
      }
      try {
        const opened = await openHandoff(
          { db: deps.db, jobs: deps.jobs, now: () => new Date((deps.now ?? Date.now)()) },
          { tenantId, conversationId: prepared.conversation.id },
          {
            reason: input.data.reason,
            summary:
              input.data.reason === "tool_failure"
                ? "Shopper accepted help after repeated tool failures."
                : "Shopper accepted help after repeated unanswered questions.",
          },
        );
        return c.json({ opened: true, handoffId: opened.id });
      } finally {
        await withTenant(deps.db, tenantId, (tx) => releaseLease(tx, prepared.conversation.id));
      }
    }
    if (isVerificationActionType(type)) {
      const body = ActionBodySchema.safeParse(await c.req.json().catch(() => null));
      if (!body.success) {
        return errorResponse(c, 400, "invalid_input", "Invalid verification request.");
      }
      const startInput =
        type === "verify_start" ? VERIFICATION_INPUTS.verify_start.safeParse(body.data.input) : null;
      const confirmInput =
        type === "verify_confirm" ? VERIFICATION_INPUTS.verify_confirm.safeParse(body.data.input) : null;
      if (startInput?.success === false || confirmInput?.success === false) {
        return errorResponse(c, 400, "invalid_input", "Invalid verification request.");
      }
      const { tenantId } = c.var.widget;
      let prepared: Awaited<ReturnType<typeof leaseExistingConversation>>;
      try {
        prepared = await leaseExistingConversation(
          deps,
          c.var.widget,
          body.data.conversationId,
          body.data.conversationToken,
        );
      } catch (error) {
        if (error instanceof TurnError) return errorResponse(c, error.status, error.code, error.message);
        throw error;
      }
      try {
        const repeated = await withTenant(deps.db, tenantId, async (tx) => {
          const stored = await loadMessages(tx, prepared.conversation.id);
          const row = stored.rows.find(
            (entry) =>
              entry.kind === "action" &&
              (entry.payload as { actionId?: unknown }).actionId === body.data.actionId,
          );
          return (row?.payload as { response?: unknown } | undefined)?.response;
        });
        if (repeated !== undefined) return c.json(repeated);
        if (type === "verify_start") {
          if (!startInput?.success) throw new Error("verification input invariant failed");
          const ip = clientIp(
            c.req.header("x-forwarded-for"),
            remoteAddress(c.env),
            deps.trustProxyHops ?? 1,
          );
          return c.json(
            await startVerification(
              deps.otp,
              { tenantId, conversationId: prepared.conversation.id, ip, actionId: body.data.actionId },
              startInput.data,
            ),
          );
        }
        if (!confirmInput?.success) throw new Error("verification input invariant failed");
        const result = await confirmVerification(
          deps.otp,
          { tenantId, conversationId: prepared.conversation.id, actionId: body.data.actionId },
          confirmInput.data,
        );
        return c.json(result.ok ? { ok: true, verified: true } : result);
      } finally {
        await withTenant(deps.db, tenantId, (tx) => releaseLease(tx, prepared.conversation.id)).catch(
          (error: unknown) => deps.logger.error({ err: error }, "could not release verification lease"),
        );
      }
    }
    const def = RUNNABLE.find((tool) => tool.name === type);
    if (!isActionType(type) || !def) return errorResponse(c, 404, "not_found", "Unknown action.");
    const body = ActionBodySchema.safeParse(await c.req.json().catch(() => null));
    const input = body.success ? ACTION_INPUTS[type].safeParse(body.data.input) : null;
    if (!body.success || !input?.success)
      return errorResponse(c, 400, "invalid_input", "Invalid action request.");

    const { tenantId } = c.var.widget;
    let prepared: Awaited<ReturnType<typeof leaseExistingConversation>>;
    try {
      prepared = await leaseExistingConversation(
        deps,
        c.var.widget,
        body.data.conversationId,
        body.data.conversationToken,
      );
    } catch (error) {
      if (error instanceof TurnError) return errorResponse(c, error.status, error.code, error.message);
      throw error;
    }

    const conversationId = prepared.conversation.id;
    const turnId = `action-${body.data.actionId}`;
    let saved = false;
    try {
      const ctx = createToolContext({
        provider: deps.providers(tenantId, prepared.store),
        conversationId,
        turnId,
        session: parseSession(prepared.conversation.session),
        cod: codPolicy(parseStoreFacts(prepared.bot.storeFacts)),
        cartId: body.data.cartId ?? prepared.conversation.cartId,
        identity: currentIdentity(prepared.conversation, new Date((deps.now ?? Date.now)())),
        onUnexpectedError: (error) => deps.logger.error({ err: error, turnId }, "action failed unexpectedly"),
      });
      if (!isToolAvailable(ctx, def)) {
        return errorResponse(c, 404, "not_found", "This store does not support that action.");
      }
      const started = Date.now();
      // Fixed tool call id: the idempotency key becomes ace:action-<actionId>:action, stable across retries.
      const result = await def.run(ctx, input.data, "action");
      // Delivery details are personal data: they stay in the session draft, never in summaries or records.
      const shown = def.sensitiveInput ? "(delivery details)" : JSON.stringify(input.data);
      const orderNumber =
        result.ok && typeof (result.data as { orderNumber?: unknown }).orderNumber === "string"
          ? ` (order ${(result.data as { orderNumber: string }).orderNumber})`
          : "";
      const summary = `${type} ${shown} → ${result.ok ? `done${orderNumber}` : result.error.code}`;

      await withTenant(deps.db, tenantId, async (tx) => {
        const stored = await loadMessages(tx, conversationId);
        const repeated = stored.rows.some(
          (row) =>
            row.kind === "action" && (row.payload as { actionId?: string }).actionId === body.data.actionId,
        );
        if (!repeated) {
          await appendMessages(tx, tenantId, conversationId, stored.nextSeq, [
            { kind: "action", payload: { actionId: body.data.actionId, type, ok: result.ok, summary } },
          ]);
          await recordToolCalls(tx, tenantId, conversationId, turnId, [
            {
              name: type,
              input: def.sensitiveInput ? null : input.data,
              output: null,
              ok: result.ok,
              errorCode: result.ok ? null : result.error.code,
              ms: Date.now() - started,
            },
          ]);
        }
        await saveSessionAndRelease(tx, conversationId, { session: ctx.session, cartId: ctx.cartId });
      });
      saved = true;
      return c.json({ result, ui: ctx.ui, cartId: ctx.cartId });
    } finally {
      if (!saved) {
        await withTenant(deps.db, tenantId, (tx) => releaseLease(tx, conversationId)).catch(
          (error: unknown) => deps.logger.error({ err: error, turnId }, "could not release lease"),
        );
      }
    }
  });
}
