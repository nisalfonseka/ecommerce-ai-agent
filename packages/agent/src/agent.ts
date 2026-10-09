import { type LanguageModel, type ModelMessage, stepCountIs, ToolLoopAgent } from "ai";
import type { ToolContext } from "./context";
import { checkUserMessage, findUngroundedAmounts, shopperAmounts } from "./guardrails";
import { composeInstructions, type Persona, type StoreFacts } from "./prompt";
import { buildTools } from "./tools/registry";
import type { UiPart } from "./ui";

export const DEFAULT_MAX_STEPS = 8;

export class AgentInputError extends Error {
  readonly reason: "empty" | "too_long";

  constructor(reason: "empty" | "too_long") {
    super(`Rejected user message: ${reason}`);
    this.name = "AgentInputError";
    this.reason = reason;
  }
}

export interface TurnInput {
  model: LanguageModel;
  ctx: ToolContext;
  persona: Persona;
  store: StoreFacts;
  /** Earlier turns' messages (each turn's `newMessages`, in order). */
  history: ModelMessage[];
  userMessage: string;
  maxSteps?: number;
}

export interface TurnResult {
  text: string;
  ui: UiPart[];
  toolCalls: { name: string; input: unknown }[];
  /** Append to history: the user message, tool steps, and the final assistant reply. */
  newMessages: ModelMessage[];
  usage: { inputTokens: number; outputTokens: number };
  /** Amounts still not backed by tool data after one regeneration; the channel must not show this text's prices. */
  ungroundedAmounts: number[];
  regenerated: boolean;
}

export async function runTurn(input: TurnInput): Promise<TurnResult> {
  const check = checkUserMessage(input.userMessage);
  if (!check.ok) throw new AgentInputError(check.reason);

  const { ctx } = input;
  const instructions = composeInstructions(input.persona, input.store);
  const tools = buildTools(ctx);
  const agent = new ToolLoopAgent({
    model: input.model,
    instructions,
    tools,
    stopWhen: stepCountIs(input.maxSteps ?? DEFAULT_MAX_STEPS),
  });
  const userMessage: ModelMessage = { role: "user", content: input.userMessage };
  const first = await agent.generate({ messages: [...input.history, userMessage] });
  const stepMessages = first.steps.flatMap((step) => step.response.messages);
  const usage = {
    inputTokens: first.totalUsage.inputTokens ?? 0,
    outputTokens: first.totalUsage.outputTokens ?? 0,
  };

  // Prices from this turn's tool results, plus numbers the shopper wrote this turn (their budget).
  const allowed = new Set([...ctx.observedAmounts, ...shopperAmounts(input.userMessage)]);
  let text = first.text;
  let messages: ModelMessage[] = [userMessage, ...stepMessages];
  let ungrounded = findUngroundedAmounts(text, allowed);
  let regenerated = false;

  if (ungrounded.length > 0) {
    regenerated = true;
    // Same tools, but disabled: some providers reject tool-call history when no tools are declared.
    const rewriter = new ToolLoopAgent({
      model: input.model,
      instructions,
      tools,
      toolChoice: "none",
      stopWhen: stepCountIs(1),
    });
    const correction: ModelMessage = {
      role: "user",
      content: `[automatic check] Your reply mentioned prices that no tool returned (${ungrounded
        .map((amount) => (amount / 100).toFixed(2))
        .join(
          ", ",
        )}). Rewrite your reply for the shopper without those prices. Use only prices that appear in tool results.`,
    };
    const second = await rewriter.generate({ messages: [...input.history, ...messages, correction] });
    usage.inputTokens += second.totalUsage.inputTokens ?? 0;
    usage.outputTokens += second.totalUsage.outputTokens ?? 0;
    text = second.text;
    ungrounded = findUngroundedAmounts(text, allowed);
    const withoutDraft = messages.slice(0, -1);
    messages = [...withoutDraft, { role: "assistant", content: text }];
  }

  return {
    text,
    ui: [...ctx.ui],
    toolCalls: first.steps.flatMap((step) =>
      step.toolCalls.map((call) => ({ name: call.toolName, input: call.input })),
    ),
    newMessages: messages,
    usage,
    ungroundedAmounts: ungrounded,
    regenerated,
  };
}
