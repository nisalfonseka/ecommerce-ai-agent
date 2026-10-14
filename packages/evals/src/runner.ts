import { defaultSeed, MemoryCommerceProvider } from "@ace/adapter-memory";
import { createSession, createToolContext, type Persona, runTurn, type StoreFacts } from "@ace/agent";
import { createStaticKnowledge } from "@ace/knowledge/testing";
import type { LanguageModel, ModelMessage } from "ai";
import { DEFAULT_KNOWLEDGE } from "./cases/knowledge";
import { scoreTurn } from "./scorers";
import type { CaseResult, EvalCase, TurnRecord } from "./types";

export interface RunCaseOptions {
  model: LanguageModel;
  modelSpec: string;
  persona: Persona;
  store: StoreFacts;
}

/** Runs one golden conversation against a fresh in-memory store. Never throws: errors become a failed case. */
export async function runCase(evalCase: EvalCase, options: RunCaseOptions): Promise<CaseResult> {
  const seed = defaultSeed();
  evalCase.setup?.seed?.(seed);
  const provider = new MemoryCommerceProvider({ seed });
  const session = createSession();
  const history: ModelMessage[] = [];
  const turns: TurnRecord[] = [];
  let cartId: string | null = null;
  const knowledge = createStaticKnowledge(evalCase.knowledge ?? DEFAULT_KNOWLEDGE);

  try {
    for (const [index, turn] of evalCase.turns.entries()) {
      const ctx = createToolContext({
        provider,
        conversationId: `eval_${evalCase.id}`,
        turnId: `${evalCase.id}_t${index + 1}`,
        identity: evalCase.setup?.identity ?? null,
        verification: { channels: ["sms", "email"] },
        session,
        cod: evalCase.setup?.cod ? { maxTotal: null, allowedCities: null, countryCode: "LK" } : null,
        knowledge,
        cartId,
      });
      const started = Date.now();
      const result = await runTurn({
        model: options.model,
        ctx,
        persona: options.persona,
        store: options.store,
        history,
        userMessage: turn.user,
      });
      const latencyMs = Date.now() - started;
      cartId = ctx.cartId;
      history.push(...result.newMessages);
      const cart = cartId === null ? null : await provider.getCart(cartId);
      const observation = {
        text: result.text,
        toolCalls: result.toolCalls,
        cart,
        ungroundedAmounts: result.ungroundedAmounts,
        ui: result.ui,
      };
      turns.push({
        ...observation,
        user: turn.user,
        checks: scoreTurn(turn.expect, observation),
        latencyMs,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
      });
    }
  } catch (error) {
    return {
      caseId: evalCase.id,
      language: evalCase.language,
      tags: evalCase.tags,
      modelSpec: options.modelSpec,
      passed: false,
      turns,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    caseId: evalCase.id,
    language: evalCase.language,
    tags: evalCase.tags,
    modelSpec: options.modelSpec,
    passed: turns.every((turn) => turn.checks.every((check) => check.pass)),
    turns,
  };
}
