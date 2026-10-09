import { type ToolSet, tool } from "ai";
import type { z } from "zod";
import type { ToolContext } from "../context";
import { addToCartTool, startCheckoutTool, updateCartLineTool, viewCartTool } from "./cart";
import { checkAvailabilityTool, getProductTool, searchProductsTool } from "./catalog";
import type { CommerceToolDef } from "./define";
import { lookupOrderTool } from "./orders";

export const ALL_TOOLS: CommerceToolDef<z.ZodType, unknown>[] = [
  searchProductsTool,
  getProductTool,
  checkAvailabilityTool,
  viewCartTool,
  addToCartTool,
  updateCartLineTool,
  startCheckoutTool,
  lookupOrderTool,
];

/** Binds tool definitions to one turn's context. Tools the provider cannot support are never shown to the model. */
export function buildTools(
  ctx: ToolContext,
  defs: CommerceToolDef<z.ZodType, unknown>[] = ALL_TOOLS,
): ToolSet {
  const tools: ToolSet = {};
  for (const def of defs) {
    if (!def.requires.every((capability) => ctx.provider.capabilities.has(capability))) continue;
    tools[def.name] = tool({
      description: def.description,
      inputSchema: def.inputSchema,
      execute: async (input, { toolCallId }) => {
        ctx.onToolStart(def.name);
        const startedAt = ctx.now();
        const result = await def.run(ctx, input, toolCallId);
        ctx.toolLog.push({
          name: def.name,
          startedAt,
          ms: ctx.now() - startedAt,
          ok: result.ok,
          errorCode: result.ok ? undefined : result.error.code,
        });
        return result;
      },
    });
  }
  return tools;
}
