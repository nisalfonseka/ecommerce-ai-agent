import { getConversation, listDisplay, withTenant } from "@ace/db";
import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { WidgetEnv } from "../auth/widget";
import { clientIp } from "../client-ip";
import { errorResponse } from "../http-errors";
import type { createRateLimiter } from "../rate-limit";
import { createEmitter } from "../sse";
import { prepareTurn, runPreparedTurn, type TurnDeps, TurnError } from "../turn";

const ChatBodySchema = z.object({
  message: z.string(),
  conversationId: z.uuid().optional(),
  conversationToken: z.string().max(512).optional(),
  /** The host site's cart, sent with every message (G2). */
  cartId: z.string().min(1).max(200).optional(),
});

const VISITOR_ID = /^[A-Za-z0-9_-]{8,64}$/;

export interface ChatDeps extends TurnDeps {
  visitorLimiter: ReturnType<typeof createRateLimiter>;
  ipLimiter: ReturnType<typeof createRateLimiter>;
  trustProxyHops?: number;
}

function remoteAddress(env: unknown): string {
  const incoming = (env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? "unknown";
}

/**
 * POST /v1/chat answers with Server-Sent Events (ADR-004): `conversation`, then `status` while tools run, then
 * the validated `reply` and `done`, or `error`. GET /v1/conversations/:id returns what the shopper saw.
 */
export function registerChatRoutes(app: Hono<WidgetEnv>, deps: ChatDeps): void {
  app.post("/v1/chat", async (c) => {
    const parsed = ChatBodySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return errorResponse(c, 400, "invalid_input", "Invalid chat request.");
    const header = c.req.header("x-visitor-id");
    const visitorId = header && VISITOR_ID.test(header) ? header : "anonymous";
    const ip = clientIp(c.req.header("x-forwarded-for"), remoteAddress(c.env), deps.trustProxyHops ?? 1);
    for (const check of [deps.visitorLimiter.check(`v:${visitorId}`), deps.ipLimiter.check(`ip:${ip}`)]) {
      if (!check.ok) {
        c.header("Retry-After", String(check.retryAfterS));
        return errorResponse(c, 429, "rate_limited", "Too many messages. Please wait a moment.");
      }
    }

    const request = { ...parsed.data, visitorId };
    let prepared: Awaited<ReturnType<typeof prepareTurn>>;
    try {
      prepared = await prepareTurn(deps, c.var.widget, request);
    } catch (error) {
      if (error instanceof TurnError) return errorResponse(c, error.status, error.code, error.message);
      throw error;
    }

    return streamSSE(c, async (stream) => {
      const { emit, flush } = createEmitter(stream);
      emit("conversation", {
        conversationId: prepared.conversation.id,
        conversationToken: prepared.conversationToken,
      });
      await runPreparedTurn(deps, prepared, request, emit);
      await flush();
    });
  });

  app.get("/v1/conversations/:id", async (c) => {
    const { tenantId, botId } = c.var.widget;
    const conversationId = c.req.param("id");
    const claims = deps.tokens.verify(c.req.header("x-conversation-token") ?? "");
    if (!claims || claims.tenantId !== tenantId || claims.conversationId !== conversationId) {
      return errorResponse(c, 404, "not_found", "Conversation not found.");
    }
    const messages = await withTenant(deps.db, tenantId, async (tx) => {
      const conversation = await getConversation(tx, conversationId);
      return conversation && conversation.botId === botId ? listDisplay(tx, conversationId) : null;
    });
    if (!messages) return errorResponse(c, 404, "not_found", "Conversation not found.");
    return c.json({ messages });
  });
}
