import { createHmac, timingSafeEqual } from "node:crypto";

/** "sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>". The timestamp is signed so a captured request cannot be replayed later. */
export function signAceWebhook(secret: string, timestamp: number, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

export function verifyAceWebhook(input: {
  secret: string;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  rawBody: string;
  nowSeconds: number;
  toleranceSeconds?: number;
}): boolean {
  const { timestampHeader, signatureHeader } = input;
  if (!timestampHeader || !signatureHeader || !/^\d{1,15}$/.test(timestampHeader)) return false;
  const timestamp = Number(timestampHeader);
  if (Math.abs(input.nowSeconds - timestamp) > (input.toleranceSeconds ?? 300)) return false;
  const expected = Buffer.from(signAceWebhook(input.secret, timestamp, input.rawBody));
  const given = Buffer.from(signatureHeader);
  // timingSafeEqual throws on unequal lengths.
  return given.length === expected.length && timingSafeEqual(given, expected);
}
