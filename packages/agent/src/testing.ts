import type { LanguageModelV4GenerateResult } from "@ai-sdk/provider";
import { MockLanguageModelV4 } from "ai/test";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

/** Test-only: a model step that calls one tool. */
export function callTool(
  toolCallId: string,
  toolName: string,
  input: unknown,
): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls", raw: undefined },
    usage,
    warnings: [],
  };
}

/** Test-only: a final text step. */
export function say(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: undefined },
    usage,
    warnings: [],
  };
}

/** Test-only: a model that returns the given steps in order. */
export function scriptedModel(responses: LanguageModelV4GenerateResult[]): MockLanguageModelV4 {
  return new MockLanguageModelV4({ doGenerate: responses });
}
