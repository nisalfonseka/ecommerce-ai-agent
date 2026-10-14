import { z } from "zod";
import { shopperAmounts } from "../guardrails";
import { runTool } from "../tool-result";
import { defineTool } from "./define";

const MAX_PASSAGES = 3;
const MAX_PASSAGE_CHARS = 1_200;
const OPEN = "BEGIN UNTRUSTED STORE PASSAGE";
const CLOSE = "END UNTRUSTED STORE PASSAGE";

function wrapPassage(text: string): string {
  const safe = text.replaceAll(OPEN, "[removed marker]").replaceAll(CLOSE, "[removed marker]");
  return `${OPEN}\n${safe.slice(0, MAX_PASSAGE_CHARS)}\n${CLOSE}`;
}

export const searchKnowledgeTool = defineTool({
  name: "search_knowledge",
  description:
    "Search the store's own policies and guides: returns, exchanges, delivery times and charges, payment methods, size guides, fabric care, store information. Use it for every policy or how-to question before answering. Never use it for prices, stock or orders. Pass a short English query.",
  requires: [],
  available: (ctx) => ctx.knowledge !== null,
  inputSchema: z.object({ query: z.string().trim().min(2).max(200) }),
  run: (ctx, input) =>
    runTool(async () => {
      const passages = await ctx.knowledge?.search(input.query, { limit: MAX_PASSAGES });
      if (!passages || passages.length === 0) {
        ctx.knowledgeMiss = true;
        return { found: false as const };
      }
      for (const passage of passages) {
        for (const amount of shopperAmounts(passage.text)) ctx.observedAmounts.add(amount);
      }
      return {
        found: true as const,
        passages: passages.slice(0, MAX_PASSAGES).map((passage) => ({
          source: passage.heading ? `${passage.documentTitle} › ${passage.heading}` : passage.documentTitle,
          text: wrapPassage(passage.text),
        })),
      };
    }, ctx.onUnexpectedError),
});
