import { type Db, getConversation, getTenantSettings, recordConsent, withTenant } from "@ace/db";
import type { Hono } from "hono";
import { z } from "zod";
import type { createConversationTokens } from "../auth/conversation-token";
import type { WidgetEnv } from "../auth/widget";
import { errorResponse } from "../http-errors";

const ConsentBody = z.strictObject({ noticeVersion: z.string().trim().min(1).max(100) });

export interface ConsentDeps {
  db: Db;
  tokens: ReturnType<typeof createConversationTokens>;
}

/** Records a later notice version for an established conversation. First-chat consent is atomic in prepareTurn. */
export function registerConsentRoutes(app: Hono<WidgetEnv>, deps: ConsentDeps): void {
  app.post("/v1/consent", async (c) => {
    const body = ConsentBody.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return errorResponse(c, 400, "invalid_input", "A notice version is required.");
    const claims = deps.tokens.verify(c.req.header("x-conversation-token") ?? "");
    const { tenantId, botId } = c.var.widget;
    if (!claims || claims.tenantId !== tenantId) {
      return errorResponse(c, 404, "not_found", "Conversation not found.");
    }
    const recorded = await withTenant(deps.db, tenantId, async (tx) => {
      const conversation = await getConversation(tx, claims.conversationId);
      if (!conversation || conversation.botId !== botId) return false;
      const settings = await getTenantSettings(tx);
      await recordConsent(tx, tenantId, {
        conversationId: conversation.id,
        noticeVersion: body.data.noticeVersion,
        noticeUrl: settings.privacyNoticeUrl,
      });
      return true;
    });
    return recorded ? c.body(null, 204) : errorResponse(c, 404, "not_found", "Conversation not found.");
  });
}
