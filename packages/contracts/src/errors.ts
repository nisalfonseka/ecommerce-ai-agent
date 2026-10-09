import { z } from "zod";

export const COMMERCE_ERROR_CODES = [
  "NOT_FOUND",
  "INVALID_INPUT",
  "OUT_OF_STOCK",
  "NOT_SUPPORTED",
  "UNAUTHORIZED",
  "CONFLICT",
  "RATE_LIMITED",
  "UPSTREAM_UNAVAILABLE",
] as const;

export type CommerceErrorCode = (typeof COMMERCE_ERROR_CODES)[number];

const RETRYABLE_CODES: ReadonlySet<CommerceErrorCode> = new Set(["RATE_LIMITED", "UPSTREAM_UNAVAILABLE"]);

/** Registered symbol, so errors from a second copy of this package are still recognised. */
const BRAND = Symbol.for("ace.commerce-error");

/**
 * The only error type adapters may throw for expected failures. Platform errors must be translated; the original
 * goes in `cause` for logs and must never be shown to the model or the shopper.
 */
export class CommerceError extends Error {
  readonly code: CommerceErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;
  readonly [BRAND] = true;

  constructor(
    code: CommerceErrorCode,
    message: string,
    details?: Record<string, unknown>,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "CommerceError";
    this.code = code;
    this.retryable = RETRYABLE_CODES.has(code);
    this.details = details;
  }
}

export function isCommerceError(error: unknown): error is CommerceError {
  return (
    error instanceof CommerceError ||
    (error instanceof Error && (error as unknown as Record<symbol, unknown>)[BRAND] === true)
  );
}

/** Validates untrusted input; throws CommerceError("INVALID_INPUT") with the zod issues. */
export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new CommerceError("INVALID_INPUT", z.prettifyError(result.error), { issues: result.error.issues });
  }
  return result.data;
}
