import { type ToolSet, tool } from "ai";
import type { z } from "zod";
import type { ToolContext } from "../context";
import { addToCartTool, startCheckoutTool, updateCartLineTool, viewCartTool } from "./cart";
import { checkAvailabilityTool, getProductTool, searchProductsTool } from "./catalog";
import { codQuoteAction, placeCodOrderAction, startCodOrderTool } from "./cod";
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
  startCodOrderTool,
  lookupOrderTool,
];

/**
 * Run only from the shopper's own clicks (engine UI actions), never given to the model: placing an order needs
 * the shopper's explicit confirmation (AGENTS.md rule 7, ADR-007).
 */
export const ACTION_TOOLS: CommerceToolDef<z.ZodType, unknown>[] = [codQuoteAction, placeCodOrderAction];

export function isToolAvailable(ctx: ToolContext, def: CommerceToolDef<z.ZodType, unknown>): boolean {
  return (
    def.requires.every((capability) => ctx.provider.capabilities.has(capability)) &&
    (def.available?.(ctx) ?? true)
  );
}

/** Binds tool definitions to one turn's context. Tools the provider cannot support are never shown to the model. */
export function buildTools(
  ctx: ToolContext,
  defs: CommerceToolDef<z.ZodType, unknown>[] = ALL_TOOLS,
): ToolSet {
  const tools: ToolSet = {};
  for (const def of defs) {
    if (!isToolAvailable(ctx, def)) continue;
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
