import { describe, expect, it } from "vitest";
import { renderMarkdown, summarize } from "./report";
import type { CaseResult } from "./types";

const turn = {
  user: "hi",
  text: "hello",
  toolCalls: [],
  cart: null,
  ungroundedAmounts: [],
  checks: [{ name: "grounded", pass: true }],
  latencyMs: 100,
  inputTokens: 10,
  outputTokens: 5,
};
const results: CaseResult[] = [
  { caseId: "a", language: "en", tags: ["search"], modelSpec: "m1", passed: true, turns: [turn] },
  { caseId: "b", language: "si", tags: ["search"], modelSpec: "m1", passed: false, turns: [turn] },
  { caseId: "a", language: "en", tags: ["search"], modelSpec: "m2", passed: true, turns: [turn] },
];

describe("report", () => {
  it("summarises pass rate, languages, tokens and latency per model", () => {
    const [m1, m2] = summarize(results);
    expect(m1).toMatchObject({
      modelSpec: "m1",
      cases: 2,
      passed: 1,
      passRate: 0.5,
      inputTokens: 20,
      outputTokens: 10,
    });
    expect(m1?.byLanguage).toEqual({ en: { cases: 1, passed: 1 }, si: { cases: 1, passed: 0 } });
    expect(m1?.avgTurnLatencyMs).toBe(100);
    expect(m2).toMatchObject({ modelSpec: "m2", cases: 1, passed: 1, passRate: 1 });
  });

  it("renders a summary table and failed-case transcripts", () => {
    const markdown = renderMarkdown(results, summarize(results));
    expect(markdown).toContain("| m1 |");
    expect(markdown).toContain("50%");
    expect(markdown).toContain("### ❌ m1 · b");
  });
});
