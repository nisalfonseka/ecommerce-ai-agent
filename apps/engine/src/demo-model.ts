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

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasTool(options: LanguageModelV4CallOptions, name: string): boolean {
  return options.tools?.some((candidate) => candidate.name === name) ?? false;
}

const POLICY_QUESTION = /\b(?:returns?|exchanges?|delivery|shipping|payments?|cod|size guide|care|wash)\b/i;
const REFUND_OR_RETURN = /\b(?:refund|return)\b/i;
const CANCELLATION = /\b(?:cancel|cancellation)\b/i;
const ORDER_NUMBER = /\bACE-\d+\b/i;

function knowledgeReply(options: LanguageModelV4CallOptions): string | null {
  const last = options.prompt.at(-1);
  if (last?.role !== "tool") return null;
  for (const part of last.content) {
    if (part.type !== "tool-result" || part.toolName !== "search_knowledge") continue;
    const output = record(part.output);
    const result = record(output?.value);
    const data = record(result?.data);
    if (data?.found !== true) {
      return "I'm not sure. Please contact the store for help. (Demo mode: no AI model is connected.)";
    }
    const passages = Array.isArray(data.passages) ? data.passages : [];
    const passage = record(passages[0]);
    const source = typeof passage?.source === "string" ? passage.source : "store policy";
    const raw = typeof passage?.text === "string" ? passage.text : "";
    const text = raw
      .replaceAll("BEGIN UNTRUSTED STORE PASSAGE", "")
      .replaceAll("END UNTRUSTED STORE PASSAGE", "")
      .trim();
    const fact = text.split(/(?<=[.!?])\s+/u)[0]?.slice(0, 500) ?? "The store has guidance on this.";
    return `According to ${source}, ${fact} (Demo mode: no AI model is connected.)`;
  }
  return null;
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
      const fromKnowledge = knowledgeReply(options);
      if (fromKnowledge) {
        return {
          content: [{ type: "text", text: fromKnowledge }],
          finishReason: { unified: "stop", raw: undefined },
          usage,
          warnings: [],
        };
      }
      const query = lastUserText(options);
      if (query) {
        const handoffReason = REFUND_OR_RETURN.test(query)
          ? "refund_or_return"
          : CANCELLATION.test(query)
            ? "cancellation"
            : null;
        if (handoffReason && hasTool(options, "request_human")) {
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: `demo-${Date.now()}`,
                toolName: "request_human",
                input: JSON.stringify({
                  reason: handoffReason,
                  summary:
                    handoffReason === "refund_or_return"
                      ? "Shopper asks for a refund or return in the local demo."
                      : "Shopper asks for a cancellation in the local demo.",
                }),
              },
            ],
            finishReason: { unified: "tool-calls", raw: undefined },
            usage,
            warnings: [],
          };
        }
        const orderNumber = ORDER_NUMBER.exec(query)?.[0]?.toUpperCase();
        if (orderNumber && hasTool(options, "lookup_order")) {
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: `demo-${Date.now()}`,
                toolName: "lookup_order",
                input: JSON.stringify({ orderNumber }),
              },
            ],
            finishReason: { unified: "tool-calls", raw: undefined },
            usage,
            warnings: [],
          };
        }
        const toolName =
          hasTool(options, "search_knowledge") && POLICY_QUESTION.test(query)
            ? "search_knowledge"
            : "search_products";
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: `demo-${Date.now()}`,
              toolName,
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
