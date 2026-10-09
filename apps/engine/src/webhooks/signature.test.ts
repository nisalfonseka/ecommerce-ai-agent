import { describe, expect, it } from "vitest";
import { signAceWebhook, verifyAceWebhook } from "./signature";

/** Shared with the reference store's test: both sides must produce the same signature. */
const VECTOR = {
  secret: "test-webhook-secret-0123456789",
  timestamp: 1791500000,
  body: '{"eventId":"product.updated:p_1:1","type":"product.updated","productId":"p_1","occurredAt":"2026-10-09T00:00:00.000Z"}',
  signature: "sha256=3d49e872361e43452cedb4c12201824c654d50f335e96d4a4f37a92643e2dbb5",
};

const verify = (overrides: Partial<Parameters<typeof verifyAceWebhook>[0]> = {}) =>
  verifyAceWebhook({
    secret: VECTOR.secret,
    timestampHeader: String(VECTOR.timestamp),
    signatureHeader: VECTOR.signature,
    rawBody: VECTOR.body,
    nowSeconds: VECTOR.timestamp,
    ...overrides,
  });

describe("ACE webhook signature", () => {
  it("matches the fixed vector", () => {
    expect(signAceWebhook(VECTOR.secret, VECTOR.timestamp, VECTOR.body)).toBe(VECTOR.signature);
  });

  it("accepts a correct request", () => {
    expect(verify()).toBe(true);
  });

  it("rejects a changed body, signature or timestamp", () => {
    expect(verify({ rawBody: VECTOR.body.replace("p_1", "p_2") })).toBe(false);
    const flipped = `${VECTOR.signature.slice(0, -1)}${VECTOR.signature.endsWith("0") ? "1" : "0"}`;
    expect(verify({ signatureHeader: flipped })).toBe(false);
    expect(verify({ timestampHeader: String(VECTOR.timestamp + 1) })).toBe(false);
    expect(verify({ secret: "other-secret" })).toBe(false);
  });

  it("rejects stale and future timestamps beyond 300 seconds, and accepts the edge", () => {
    expect(verify({ nowSeconds: VECTOR.timestamp + 301 })).toBe(false);
    expect(verify({ nowSeconds: VECTOR.timestamp - 301 })).toBe(false);
    expect(verify({ nowSeconds: VECTOR.timestamp + 300 })).toBe(true);
    expect(verify({ nowSeconds: VECTOR.timestamp - 300 })).toBe(true);
  });

  it("rejects missing or malformed headers", () => {
    expect(verify({ timestampHeader: undefined })).toBe(false);
    expect(verify({ signatureHeader: undefined })).toBe(false);
    expect(verify({ timestampHeader: "abc" })).toBe(false);
    expect(verify({ timestampHeader: "" })).toBe(false);
  });

  it("rejects a signature of a different length without throwing", () => {
    expect(verify({ signatureHeader: "sha256=abcd" })).toBe(false);
    expect(verify({ signatureHeader: `${VECTOR.signature}00` })).toBe(false);
    expect(verify({ signatureHeader: "" })).toBe(false);
  });
});
