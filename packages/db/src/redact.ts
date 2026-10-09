const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 13–19 digits, optionally grouped by spaces or dashes: payment card numbers.
const CARD = /\b(?:\d[ -]?){12,18}\d\b/g;
// E.164 (+94771234567) and Sri Lankan local numbers (0771234567, 077 123 4567).
const PHONE = /\+\d{7,15}\b|\b0\d{2}[ -]?\d{3}[ -]?\d{4}\b/g;

/** Replaces emails, phone numbers and card-like digit runs. Keeps order numbers, sizes and prices. */
export function redactPii(text: string): string {
  return text.replace(EMAIL, "[email]").replace(CARD, "[number]").replace(PHONE, "[phone]");
}

function redactValue(value: unknown): unknown {
  if (typeof value === "string") return redactPii(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item)]));
  }
  return value;
}

/**
 * Redacts every string in a JSON-like value for storage in tool-call records and traces. Results larger than
 * `maxBytes` (as JSON) become `{ truncated: true, preview }`.
 */
export function redactDeep(value: unknown, maxBytes = 8192): unknown {
  const redacted = redactValue(value);
  const json = JSON.stringify(redacted) ?? "null";
  if (json.length <= maxBytes) return redacted;
  let length = maxBytes;
  for (;;) {
    const truncated = { truncated: true, preview: json.slice(0, length) };
    if (JSON.stringify(truncated).length <= maxBytes) return truncated;
    length = Math.floor(length * 0.9);
  }
}
