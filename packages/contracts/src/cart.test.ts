import { describe, expect, it } from "vitest";
import {
  AddCartLinesInputSchema,
  CreateCartInputSchema,
  MAX_LINE_QUANTITY,
  UpdateCartAttributesInputSchema,
  UpdateCartLineInputSchema,
  WriteOptionsSchema,
} from "./cart";

describe("cart inputs", () => {
  it("accepts quantities from 1 to MAX_LINE_QUANTITY when adding", () => {
    expect(AddCartLinesInputSchema.safeParse({ lines: [{ variantId: "v", quantity: 1 }] }).success).toBe(
      true,
    );
    const max = { lines: [{ variantId: "v", quantity: MAX_LINE_QUANTITY }] };
    expect(AddCartLinesInputSchema.safeParse(max).success).toBe(true);
  });

  it("rejects zero, negative, fractional and oversized quantities when adding", () => {
    for (const quantity of [0, -1, 1.5, MAX_LINE_QUANTITY + 1]) {
      const result = AddCartLinesInputSchema.safeParse({ lines: [{ variantId: "v", quantity }] });
      expect(result.success, `quantity ${quantity}`).toBe(false);
    }
  });

  it("rejects an empty line list", () => {
    expect(AddCartLinesInputSchema.safeParse({ lines: [] }).success).toBe(false);
  });

  it("allows quantity 0 on update (removes the line)", () => {
    expect(UpdateCartLineInputSchema.parse({ lineId: "l1", quantity: 0 })).toEqual({
      lineId: "l1",
      quantity: 0,
    });
  });

  it("defaults cart attributes to an empty object and caps value length", () => {
    expect(CreateCartInputSchema.parse({})).toEqual({ attributes: {} });
    const long = { attributes: { note: "x".repeat(256) } };
    expect(CreateCartInputSchema.safeParse(long).success).toBe(false);
  });

  it("requires an idempotency key of at least 8 characters", () => {
    expect(WriteOptionsSchema.safeParse({ idempotencyKey: "short" }).success).toBe(false);
    expect(WriteOptionsSchema.safeParse({ idempotencyKey: "turn-1:call-1" }).success).toBe(true);
  });
});

describe("UpdateCartAttributesInputSchema", () => {
  it("requires at least one attribute", () => {
    expect(UpdateCartAttributesInputSchema.safeParse({ attributes: {} }).success).toBe(false);
  });

  it("caps key and value length", () => {
    expect(UpdateCartAttributesInputSchema.safeParse({ attributes: { ["k".repeat(65)]: "v" } }).success).toBe(
      false,
    );
    expect(UpdateCartAttributesInputSchema.safeParse({ attributes: { k: "v".repeat(256) } }).success).toBe(
      false,
    );
    expect(
      UpdateCartAttributesInputSchema.safeParse({ attributes: { ace_conversation_id: "conv_1" } }).success,
    ).toBe(true);
  });
});
