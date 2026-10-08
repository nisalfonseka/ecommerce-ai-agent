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

/** The only error type adapters may throw for expected failures. Platform errors must be translated. */
export class CommerceError extends Error {
  readonly code: CommerceErrorCode;
  readonly retryable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: CommerceErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "CommerceError";
    this.code = code;
    this.retryable = RETRYABLE_CODES.has(code);
    this.details = details;
  }
}

export function isCommerceError(error: unknown): error is CommerceError {
  return error instanceof CommerceError;
}

/** Validates untrusted input; throws CommerceError("INVALID_INPUT") with the zod issues. */
export function parseInput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new CommerceError("INVALID_INPUT", z.prettifyError(result.error), { issues: result.error.issues });
  }
  return result.data;
}
