import { MemoryCommerceProvider } from "@ace/adapter-memory";
import type { VerifiedIdentity } from "@ace/contracts";
import { describe, expect, it } from "vitest";
import { createToolContext } from "../context";
import { lookupOrderTool } from "./orders";

const verifiedAt = "2026-10-01T00:00:00.000Z";
const make = (identity: VerifiedIdentity | null) =>
  createToolContext({ provider: new MemoryCommerceProvider(), conversationId: "c", turnId: "t1", identity });

describe("lookup_order", () => {
  it("asks for verification and reveals nothing without an identity", async () => {
    const ctx = make(null);
    const result = await lookupOrderTool.run(ctx, { orderNumber: "ACE-1001" }, "c1");
    expect(result).toMatchObject({ ok: false, error: { code: "NEEDS_VERIFICATION" } });
    expect(JSON.stringify(result)).not.toContain("Demo Courier");
    expect(ctx.ui).toEqual([{ type: "verification_required", reason: "order_lookup" }]);
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
});
