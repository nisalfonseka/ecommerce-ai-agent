import type { ToolContext } from "../context";
import { resolveProductRef } from "../session";
import { ToolFailure } from "../tool-result";

export function resolveProductId(
  ctx: ToolContext,
  input: { ref?: string | undefined; productId?: string | undefined },
): string {
  if (input.ref !== undefined) {
    const shown = resolveProductRef(ctx.session, input.ref);
    if (!shown) {
      throw new ToolFailure(
        "UNKNOWN_REF",
        `No product ${input.ref} in the latest results. Search again and use the new numbers.`,
        {
          ref: input.ref,
          shown: ctx.session.shown.length,
        },
      );
    }
    return shown.productId;
  }
  if (input.productId !== undefined) return input.productId;
  throw new ToolFailure(
    "UNKNOWN_REF",
    "Say which product: a #number from the latest results or a productId.",
  );
}
