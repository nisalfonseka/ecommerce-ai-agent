import { describe, expect, it } from "vitest";
import { redactDeep, redactPii } from "./redact";

describe("redactPii", () => {
  it.each([
    ["call me on +94771234567", "call me on [phone]"],
    ["my number is 0771234567 thanks", "my number is [phone] thanks"],
    ["077 123 4567", "[phone]"],
    ["mail a.b+x@shop.lk now", "mail [email] now"],
    ["card 4111 1111 1111 1111", "card [number]"],
    ["card 4111-1111-1111-1111", "card [number]"],
    ["order ACE-1001 costs LKR 18,500.00", "order ACE-1001 costs LKR 18,500.00"],
    ["size 32, 2 items", "size 32, 2 items"],
  ])("%s", (input, expected) => {
    expect(redactPii(input)).toBe(expected);
  });
});

describe("redactDeep", () => {
  it("redacts every string in nested data and keeps the shape", () => {
    expect(redactDeep({ q: "for a.b@x.lk", list: [{ phone: "+94771234567" }, 3, null], ok: true })).toEqual({
      q: "for [email]",
      list: [{ phone: "[phone]" }, 3, null],
      ok: true,
    });
  });

  it("truncates large values", () => {
    const result = redactDeep({ text: "x".repeat(20_000) }, 1_000);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(1_000);
    expect(result).toEqual({ truncated: true, preview: expect.any(String) });
  });
});
