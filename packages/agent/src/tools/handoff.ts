import { z } from "zod";
import { runTool } from "../tool-result";
import { defineTool } from "./define";

const HandoffReasonSchema = z.enum([
  "asked_for_person",
  "refund_or_return",
  "cancellation",
  "complaint",
  "tool_failure",
  "not_sure",
  "other",
]);

export const requestHumanTool = defineTool({
  name: "request_human",
  description:
    "Request a human for refunds, returns, cancellations, complaints, an explicit request for a person, repeated failures, or when unsure. Summarise what the shopper wants and what was tried without promising an outcome or response time.",
  requires: [],
  available: (ctx) => ctx.handoff !== null,
  inputSchema: z.strictObject({
    reason: HandoffReasonSchema,
    summary: z.string().trim().min(1).max(600),
  }),
  run: (ctx, input) =>
    runTool(async () => {
      if (!ctx.handoff) throw new Error("request_human was run while unavailable");
      const opened = await ctx.handoff.request(input);
      ctx.ui.push({ type: "handoff", status: "requested" });
      return { opened: true as const, expectedResponse: opened.expectedResponse };
    }, ctx.onUnexpectedError),
});
