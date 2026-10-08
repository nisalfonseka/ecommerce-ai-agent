import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CommerceError, isCommerceError, parseInput } from "./errors";

describe("CommerceError", () => {
  it("marks only transient failures as retryable", () => {
    expect(new CommerceError("RATE_LIMITED", "slow down").retryable).toBe(true);
    expect(new CommerceError("UPSTREAM_UNAVAILABLE", "down").retryable).toBe(true);
    expect(new CommerceError("OUT_OF_STOCK", "gone").retryable).toBe(false);
    expect(new CommerceError("INVALID_INPUT", "bad").retryable).toBe(false);
  });

  it("keeps code, message and details", () => {
    const error = new CommerceError("NOT_FOUND", "no cart", { cartId: "c1" });
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("CommerceError");
    expect(error.code).toBe("NOT_FOUND");
    expect(error.message).toBe("no cart");
    expect(error.details).toEqual({ cartId: "c1" });
  });

  it("is recognised by isCommerceError", () => {
    expect(isCommerceError(new CommerceError("CONFLICT", "x"))).toBe(true);
    expect(isCommerceError(new Error("x"))).toBe(false);
    expect(isCommerceError("x")).toBe(false);
  });
});

describe("parseInput", () => {
  const schema = z.object({ quantity: z.number().int().min(1) });

  it("returns parsed data for valid input", () => {
    expect(parseInput(schema, { quantity: 2 })).toEqual({ quantity: 2 });
  });

  it("throws INVALID_INPUT with zod issues for invalid input", () => {
    try {
      parseInput(schema, { quantity: 0 });
      expect.unreachable("parseInput should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(CommerceError);
      expect((error as CommerceError).code).toBe("INVALID_INPUT");
      expect((error as CommerceError).details?.issues).toBeInstanceOf(Array);
    }
  });
});
