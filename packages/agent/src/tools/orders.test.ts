import { MemoryCommerceProvider } from "@ace/adapter-memory";
import type { VerifiedIdentity } from "@ace/contracts";
import { describe, expect, it } from "vitest";
import { createToolContext } from "../context";
import { listOrdersTool, lookupOrderTool } from "./orders";

const verifiedAt = "2026-10-01T00:00:00.000Z";
const make = (identity: VerifiedIdentity | null, provider = new MemoryCommerceProvider()) =>
  createToolContext({
    provider,
    conversationId: "c",
    turnId: "t1",
    identity,
    verification: { channels: ["sms", "email"] },
  });

describe("lookup_order", () => {
  it("asks for verification and reveals nothing without an identity", async () => {
    let calls = 0;
    const base = new MemoryCommerceProvider();
    const provider = Object.assign(Object.create(base), {
      lookupOrder: async () => {
        calls += 1;
        return null;
      },
    }) as MemoryCommerceProvider;
    const ctx = make(null, provider);
    const result = await lookupOrderTool.run(ctx, { orderNumber: "ACE-1001" }, "c1");
    expect(result).toMatchObject({ ok: false, error: { code: "NEEDS_VERIFICATION" } });
    expect(JSON.stringify(result)).not.toContain("Demo Courier");
    expect(ctx.ui).toEqual([
      { type: "verification_form", channels: ["sms", "email"], reason: "order_lookup" },
    ]);
    expect(calls).toBe(0);
  });

  it("returns status and tracking to the verified owner", async () => {
    const ctx = make({ method: "email_otp", email: "customer@example.com", verifiedAt });
    const result = await lookupOrderTool.run(ctx, { orderNumber: "ace-1001" }, "c1");
    expect(result).toMatchObject({
      ok: true,
      data: {
        number: "ACE-1001",
        status: "shipped",
        total: "LKR 18,500.00",
        tracking: [{ number: "DC123456789" }],
      },
    });
    expect(ctx.ui.at(-1)?.type).toBe("order");
  });

  it("gives a stranger the same NOT_FOUND as a missing order", async () => {
    const stranger = await lookupOrderTool.run(
      make({ method: "email_otp", email: "someone@example.com", verifiedAt }),
      { orderNumber: "ACE-1001" },
      "c1",
    );
    const missing = await lookupOrderTool.run(
      make({ method: "email_otp", email: "customer@example.com", verifiedAt }),
      { orderNumber: "ACE-9999" },
      "c1",
    );
    expect(stranger).toEqual(missing);
    expect(stranger).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  it("lists only the verified shopper's recent orders and observes their totals", async () => {
    const ctx = make({ method: "email_otp", email: "customer@example.com", verifiedAt });
    const result = await listOrdersTool.run(ctx, { limit: 5 }, "c1");
    expect(result).toMatchObject({
      ok: true,
      data: { orders: [{ number: "ACE-1001", status: "shipped", total: "LKR 18,500.00" }] },
    });
    expect(ctx.ui.map((part) => part.type)).toEqual(["order"]);
    expect(ctx.observedAmounts.has(1_850_000)).toBe(true);
  });

  it("keeps identity fields out of strict model tool inputs", () => {
    for (const schema of [lookupOrderTool.inputSchema, listOrdersTool.inputSchema]) {
      expect(schema.safeParse({ orderNumber: "ACE-1001", email: "customer@example.com" }).success).toBe(
        false,
      );
      expect(schema.safeParse({ limit: 5, phone: "+94771234567" }).success).toBe(false);
      expect(schema.safeParse({ limit: 5, customerId: "cus_1" }).success).toBe(false);
    }
  });
});
