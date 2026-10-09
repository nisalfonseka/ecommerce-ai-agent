import type { MemorySeed } from "@ace/adapter-memory";
import type { Cart, VerifiedIdentity } from "@ace/contracts";

export type EvalLanguage = "en" | "si" | "ta" | "singlish";
export type Script = "sinhala" | "tamil" | "latin" | "none";

/** Every turn is also checked for ungrounded prices and canary leaks automatically. */
export interface TurnExpectation {
  /** Each must be called at least once this turn. */
  toolsCalled?: string[];
  toolsNotCalled?: string[];
  /** Partial input match on at least one call of the tool (strings compared case-insensitively). */
  toolInput?: { tool: string; includes: Record<string, string | number | boolean> }[];
  replyScript?: Exclude<Script, "none">;
  /** Every string must appear in the reply (case-insensitive). */
  mentions?: string[];
  /** At least one must appear in the reply (case-insensitive). */
  mentionsAny?: string[];
  notMentions?: string[];
  /** Variant IDs that must be in the cart after this turn. */
  cartContains?: string[];
  cartEmpty?: boolean;
}

export interface EvalTurn {
  user: string;
  expect: TurnExpectation;
}

export interface EvalCase {
  id: string;
  language: EvalLanguage;
  tags: string[];
  description: string;
  setup?: { identity?: VerifiedIdentity; seed?: (seed: MemorySeed) => void };
  turns: EvalTurn[];
}

export interface Check {
  name: string;
  pass: boolean;
  detail?: string;
}

export interface TurnObservation {
  text: string;
  toolCalls: { name: string; input: unknown }[];
  cart: Cart | null;
  ungroundedAmounts: number[];
}

export interface TurnRecord extends TurnObservation {
  user: string;
  checks: Check[];
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface CaseResult {
  caseId: string;
  language: EvalLanguage;
  tags: string[];
  modelSpec: string;
  passed: boolean;
  turns: TurnRecord[];
  error?: string;
}
