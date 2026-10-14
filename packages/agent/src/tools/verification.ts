import { z } from "zod";
import { runTool } from "../tool-result";
import { defineTool } from "./define";

export const startVerificationTool = defineTool({
  name: "start_verification",
  description:
    "Show the secure email/SMS verification form for order support. Call this instead of asking for an address, phone number, or code in chat, then wait for the shopper to use the form.",
  requires: [],
  inputSchema: z.strictObject({}),
  available: (ctx) => ctx.verification !== null,
  run: (ctx) =>
    runTool(async () => {
      if (!ctx.verification) throw new Error("start_verification was run while unavailable");
      ctx.ui.push({
        type: "verification_form",
        channels: ctx.verification.channels,
        reason: "order_lookup",
      });
      return { shown: true };
    }, ctx.onUnexpectedError),
});
