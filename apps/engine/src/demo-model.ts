import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
} from "@ai-sdk/provider";

const usage = {
  inputTokens: { total: 0, noCache: 0, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 0, text: 0, reasoning: undefined },
};

function lastUserText(options: LanguageModelV4CallOptions): string {
  const message = options.prompt.at(-1);
  if (message?.role !== "user") return "";
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join(" ")
    .trim()
    .slice(0, 200);
}

/**
 * A keyless stand-in for a real model, for local demos and smoke tests only (main.ts refuses it in production).
 * It searches the catalog for whatever the shopper wrote, then says it is a demo. Product cards carry the data.
 */
export function createDemoModel(): LanguageModelV4 {
  return {
    specificationVersion: "v4",
    provider: "demo",
    modelId: "search-only",
    supportedUrls: {},
    async doGenerate(options): Promise<LanguageModelV4GenerateResult> {
      const query = lastUserText(options);
      if (query) {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: `demo-${Date.now()}`,
              toolName: "search_products",
              input: JSON.stringify({ query }),
            },
          ],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage,
          warnings: [],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: "Here is what I found in the catalog. (Demo mode: no AI model is connected.)",
          },
        ],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      };
    },
    async doStream() {
      throw new Error("The demo model does not stream");
    },
  };
}
