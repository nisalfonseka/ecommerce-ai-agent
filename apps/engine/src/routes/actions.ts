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
import { errorResponse } from "../http-errors";
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

type ActionType = keyof typeof ACTION_INPUTS;

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

/**
 * POST /v1/actions/:type: deterministic card actions (spec J7). They run the same tool code with the same
 * ToolContext as a chat turn, but no model. The outcome is stored as an "action" message so the next turn
 * knows about it.
 */
export function registerActionRoutes(app: Hono<WidgetEnv>, deps: TurnDeps): void {
  app.post("/v1/actions/:type", async (c) => {
    const type = c.req.param("type");
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
