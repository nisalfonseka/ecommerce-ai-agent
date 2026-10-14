import { MemoryCommerceProvider } from "@ace/adapter-memory";
import { describe, expect, it } from "vitest";
import { createToolContext } from "../context";
import { requestHumanTool } from "./handoff";

describe("request_human", () => {
  it("opens one engine-owned handoff and pushes deterministic UI", async () => {
    const requests: unknown[] = [];
    const ctx = createToolContext({
      provider: new MemoryCommerceProvider(),
      conversationId: "conv",
      turnId: "turn",
      handoff: {
        request: async (input) => {
          requests.push(input);
          return { id: "ho_1", created: true, expectedResponse: "A team member will reply here." };
        },
      },
    });
    const result = await requestHumanTool.run(
      ctx,
      { reason: "refund_or_return", summary: "Shopper wants a refund for order ACE-1001." },
      "call_1",
    );
    expect(requests).toEqual([
      { reason: "refund_or_return", summary: "Shopper wants a refund for order ACE-1001." },
    ]);
    expect(result).toEqual({
      ok: true,
      data: { opened: true, expectedResponse: "A team member will reply here." },
    });
    expect(ctx.ui).toEqual([{ type: "handoff", status: "requested" }]);
  });

  it("is hidden without an engine handoff port and validates model input strictly", () => {
    const ctx = createToolContext({
      provider: new MemoryCommerceProvider(),
      conversationId: "conv",
      turnId: "turn",
    });
    expect(requestHumanTool.available?.(ctx)).toBe(false);
    expect(
      requestHumanTool.inputSchema.safeParse({
        reason: "complaint",
        summary: "Help",
        tenantId: "tenant-from-model",
      }).success,
    ).toBe(false);
    expect(requestHumanTool.inputSchema.safeParse({ reason: "refund", summary: "Help" }).success).toBe(false);
    expect(
      requestHumanTool.inputSchema.safeParse({ reason: "complaint", summary: "x".repeat(601) }).success,
    ).toBe(false);
  });
});
