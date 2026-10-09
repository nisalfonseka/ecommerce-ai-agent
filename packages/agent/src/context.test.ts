import { MemoryCommerceProvider } from "@ace/adapter-memory";
import { WriteOptionsSchema } from "@ace/contracts";
import { describe, expect, it } from "vitest";
import { createToolContext, observeMoney, writeKey } from "./context";

const make = () =>
  createToolContext({ provider: new MemoryCommerceProvider(), conversationId: "conv_1", turnId: "t1" });

describe("ToolContext", () => {
  it("starts with an empty UI collector, no cart, no identity and a fresh session", () => {
    const ctx = make();
    expect(ctx.ui).toEqual([]);
    expect(ctx.cartId).toBeNull();
    expect(ctx.identity).toBeNull();
    expect(ctx.session.shown).toEqual([]);
  });

  it("derives deterministic, schema-valid idempotency keys from turn and tool call", () => {
    const ctx = make();
    expect(writeKey(ctx, "c1")).toEqual({ idempotencyKey: "ace:t1:c1" });
    expect(WriteOptionsSchema.safeParse(writeKey(ctx, "c1")).success).toBe(true);
  });

  it("records every Money amount found in a nested value", () => {
    const ctx = make();
    observeMoney(ctx, {
      priceRange: { min: { amount: 100, currency: "LKR" }, max: { amount: 200, currency: "LKR" } },
      lines: [{ lineTotal: { amount: 300, currency: "LKR" }, quantity: 3 }],
      note: "amount 999",
    });
    expect([...ctx.observedAmounts].sort((a, b) => a - b)).toEqual([100, 200, 300]);
  });
});
