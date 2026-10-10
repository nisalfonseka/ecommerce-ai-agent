import type { KnowledgeSourceErrorCode } from "@ace/knowledge";
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type ErrorCode =
  | "unauthorized"
  | "forbidden_origin"
  | "rate_limited"
  | "invalid_input"
  | "not_found"
  | "invalid_signature"
  | "unavailable"
  | "turn_in_progress"
  | "internal"
  /** Knowledge upload: why the source could not be extracted (too_large also for an oversized body). */
  | KnowledgeSourceErrorCode;

/** The one error shape every route returns. */
export function errorResponse(c: Context, status: ContentfulStatusCode, code: ErrorCode, message: string) {
  return c.json({ error: { code, message } }, status);
}
