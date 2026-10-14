import { MemoryCommerceProvider } from "@ace/adapter-memory";
import { describe, expect, it } from "vitest";
import { createToolContext } from "../context";
import { startVerificationTool } from "./verification";

describe("start_verification", () => {
  it("shows the configured form and accepts no model-supplied identity fields", async () => {
    const ctx = createToolContext({
      provider: new MemoryCommerceProvider(),
      conversationId: "c",
      turnId: "t",
      verification: { channels: ["email"] },
    });
    expect(startVerificationTool.available?.(ctx)).toBe(true);
    expect(startVerificationTool.inputSchema.safeParse({ email: "customer@example.com" }).success).toBe(
      false,
    );
    expect(await startVerificationTool.run(ctx, {}, "c1")).toEqual({ ok: true, data: { shown: true } });
    expect(ctx.ui).toEqual([{ type: "verification_form", channels: ["email"], reason: "order_lookup" }]);
  });

  it("is unavailable when verification is disabled", () => {
    const ctx = createToolContext({
      provider: new MemoryCommerceProvider(),
      conversationId: "c",
      turnId: "t",
    });
    expect(startVerificationTool.available?.(ctx)).toBe(false);
  });
});
