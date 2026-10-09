import type { Capability } from "@ace/contracts";
import type { z } from "zod";
import type { ToolContext } from "../context";
import type { ToolResult } from "../tool-result";

/** A platform-agnostic tool. The registry turns it into an AI SDK tool bound to one turn's ToolContext. */
export interface CommerceToolDef<S extends z.ZodType, O = unknown> {
  name: string;
  /** Written for the model: say when to use the tool and what it returns. */
  description: string;
  inputSchema: S;
  /** Registered only when the provider declares all of these. */
  requires: Capability[];
  run(ctx: ToolContext, input: z.output<S>, toolCallId: string): Promise<ToolResult<O>>;
}

/** Identity helper that infers the input schema and output type, so tests see typed `data`. */
export function defineTool<S extends z.ZodType, O>(def: CommerceToolDef<S, O>): CommerceToolDef<S, O> {
  return def;
}
