import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type ErrorCode =
  | "unauthorized"
  | "forbidden_origin"
  | "rate_limited"
  | "invalid_input"
  | "not_found"
  | "turn_in_progress"
  | "internal";

/** The one error shape every route returns. */
export function errorResponse(c: Context, status: ContentfulStatusCode, code: ErrorCode, message: string) {
  return c.json({ error: { code, message } }, status);
}
