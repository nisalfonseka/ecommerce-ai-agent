import type { Hono } from "hono";
import { z } from "zod";
import type { createConversationTokens } from "../auth/conversation-token";
import type { WidgetEnv } from "../auth/widget";
import { errorResponse } from "../http-errors";
import type { DevOutbox } from "../identity/dev-outbox";

const QuerySchema = z.object({ conversation: z.uuid() });

export interface DevOutboxDeps {
  outbox: DevOutbox;
  tokens: ReturnType<typeof createConversationTokens>;
}

/** Registers the log-notifier test hook only when the caller supplies non-production dependencies. */
export function registerDevOutboxRoute(app: Hono<WidgetEnv>, deps: DevOutboxDeps | null): void {
  if (!deps) return;
  app.get("/v1/dev/outbox", (c) => {
    const parsed = QuerySchema.safeParse(c.req.query());
    if (!parsed.success) return errorResponse(c, 400, "invalid_input", "Invalid conversation.");
    const { tenantId } = c.var.widget;
    const conversationId = parsed.data.conversation;
    const claims = deps.tokens.verify(c.req.header("x-conversation-token") ?? "");
    if (!claims || claims.tenantId !== tenantId || claims.conversationId !== conversationId) {
      return errorResponse(c, 404, "not_found", "Message not found.");
    }
    const message = deps.outbox.latest(tenantId, conversationId);
    if (!message) return errorResponse(c, 404, "not_found", "Message not found.");
    c.header("Cache-Control", "no-store");
    return c.json({ messages: [message] });
  });
}
