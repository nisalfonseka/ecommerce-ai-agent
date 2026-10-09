import type { MiddlewareHandler } from "hono";
import { errorResponse } from "../http-errors";

export interface WidgetIdentity {
  tenantId: string;
  botId: string;
  origin: string;
}

export type WidgetEnv = { Variables: { widget: WidgetIdentity } };

export type ResolveWidgetKey = (
  key: string,
) => Promise<{ tenantId: string; botId: string; allowedOrigins: string[] } | null>;

const ALLOW_HEADERS = "authorization, content-type, x-visitor-id, x-conversation-token";

/**
 * Publishable widget key (Bearer pk_…) + Origin allow-list. Preflight cannot carry the key, so it is answered
 * for the requesting origin only; the real request is refused, without CORS headers, unless the origin is on
 * the key's list.
 */
export function widgetAuth(deps: { resolveWidgetKey: ResolveWidgetKey }): MiddlewareHandler<WidgetEnv> {
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (c.req.method === "OPTIONS") {
      if (!origin) return c.body(null, 204);
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      c.header("Access-Control-Allow-Headers", ALLOW_HEADERS);
      c.header("Access-Control-Max-Age", "600");
      c.header("Vary", "Origin");
      return c.body(null, 204);
    }

    const match = /^Bearer (pk_[A-Za-z0-9_-]+)$/.exec(c.req.header("authorization") ?? "");
    const key = match?.[1];
    const resolved = key ? await deps.resolveWidgetKey(key) : null;
    if (!resolved) return errorResponse(c, 401, "unauthorized", "Unknown or revoked widget key.");
    if (!origin || !resolved.allowedOrigins.includes(origin)) {
      return errorResponse(c, 403, "forbidden_origin", "This site is not allowed to use this widget key.");
    }

    c.set("widget", { tenantId: resolved.tenantId, botId: resolved.botId, origin });
    c.header("Access-Control-Allow-Origin", origin);
    c.header("Vary", "Origin");
    await next();
  };
}
