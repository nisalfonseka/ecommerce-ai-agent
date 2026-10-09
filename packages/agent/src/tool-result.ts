import { type CommerceErrorCode, isCommerceError } from "@ace/contracts";

export type ToolFailureCode =
  | CommerceErrorCode
  | "UNKNOWN_REF"
  | "NEEDS_OPTIONS"
  | "NEEDS_VERIFICATION"
  | "NO_CART";

export interface ToolError {
  code: ToolFailureCode;
  message: string;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export type ToolResult<T> = { ok: true; data: T } | { ok: false; error: ToolError };

/** Expected agent-level failure (not a store error); the message is written for the model. */
export class ToolFailure extends Error {
  readonly code: ToolFailureCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ToolFailureCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "ToolFailure";
    this.code = code;
    this.details = details;
  }
}

function withoutIssues(details: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (details === undefined) return undefined;
  const { issues: _issues, ...rest } = details;
  return rest;
}

/** Tools never throw to the model: every outcome becomes a ToolResult the model can reason about. */
export async function runTool<T>(
  fn: () => Promise<T>,
  onUnexpected?: (error: unknown) => void,
): Promise<ToolResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    if (error instanceof ToolFailure) {
      return {
        ok: false,
        error: { code: error.code, message: error.message, retryable: false, details: error.details },
      };
    }
    if (isCommerceError(error)) {
      return {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          retryable: error.retryable,
          details: withoutIssues(error.details),
        },
      };
    }
    // A cancelled turn must stop, not become a tool result the model keeps reasoning about.
    if (error instanceof Error && error.name === "AbortError") throw error;
    onUnexpected?.(error);
    return {
      ok: false,
      error: {
        code: "UPSTREAM_UNAVAILABLE",
        message: "The store could not be reached. Apologise, and offer to try again or to connect a person.",
        retryable: true,
      },
    };
  }
}
