import { CommerceError } from "./errors";

/** Normalises a platform datetime to the contract's form: UTC, milliseconds, `Z` (the schemas reject offsets). */
export function toIsoDateTime(value: string | Date): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) {
    throw new CommerceError("INVALID_INPUT", "Not a datetime.", { value: String(value) });
  }
  return date.toISOString();
}
