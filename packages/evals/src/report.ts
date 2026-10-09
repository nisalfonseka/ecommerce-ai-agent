import type { CaseResult, EvalLanguage } from "./types";

export interface ModelSummary {
  modelSpec: string;
  cases: number;
  passed: number;
  passRate: number;
  byLanguage: Partial<Record<EvalLanguage, { cases: number; passed: number }>>;
  inputTokens: number;
  outputTokens: number;
  avgTurnLatencyMs: number;
}

export function summarize(results: CaseResult[]): ModelSummary[] {
  const byModel = new Map<string, CaseResult[]>();
  for (const result of results)
    byModel.set(result.modelSpec, [...(byModel.get(result.modelSpec) ?? []), result]);
  return [...byModel.entries()].map(([modelSpec, cases]) => {
    const turns = cases.flatMap((result) => result.turns);
    const byLanguage: ModelSummary["byLanguage"] = {};
    for (const result of cases) {
      const entry = byLanguage[result.language] ?? { cases: 0, passed: 0 };
      entry.cases += 1;
      if (result.passed) entry.passed += 1;
      byLanguage[result.language] = entry;
    }
    const passed = cases.filter((result) => result.passed).length;
    return {
      modelSpec,
      cases: cases.length,
      passed,
      passRate: cases.length === 0 ? 0 : passed / cases.length,
      byLanguage,
      inputTokens: turns.reduce((sum, turn) => sum + turn.inputTokens, 0),
      outputTokens: turns.reduce((sum, turn) => sum + turn.outputTokens, 0),
      avgTurnLatencyMs:
        turns.length === 0
          ? 0
          : Math.round(turns.reduce((sum, turn) => sum + turn.latencyMs, 0) / turns.length),
    };
  });
}

const percent = (value: number) => `${Math.round(value * 100)}%`;

export function renderMarkdown(results: CaseResult[], summaries: ModelSummary[]): string {
  const languages: EvalLanguage[] = ["en", "si", "ta", "singlish"];
  const lines = [
    "# ACE agent eval report",
    "",
    `| Model | Pass | ${languages.join(" | ")} | Input tok | Output tok | Avg turn ms |`,
    `|---|---|${languages.map(() => "---").join("|")}|---|---|---|`,
    ...summaries.map((s) => {
      const perLanguage = languages.map((language) => {
        const entry = s.byLanguage[language];
        return entry ? `${entry.passed}/${entry.cases}` : "–";
      });
      return `| ${s.modelSpec} | ${percent(s.passRate)} (${s.passed}/${s.cases}) | ${perLanguage.join(" | ")} | ${s.inputTokens} | ${s.outputTokens} | ${s.avgTurnLatencyMs} |`;
    }),
    "",
    "## Failed cases",
  ];
  for (const result of results.filter((r) => !r.passed)) {
    lines.push("", `### ❌ ${result.modelSpec} · ${result.caseId}`);
    if (result.error) lines.push(`Error: ${result.error}`);
    for (const turn of result.turns) {
      lines.push(
        "",
        `**Shopper:** ${turn.user}`,
        `**Agent:** ${turn.text}`,
        `Tools: ${turn.toolCalls.map((call) => `${call.name}(${JSON.stringify(call.input)})`).join(", ") || "none"}`,
        `Failed checks: ${
          turn.checks
            .filter((c) => !c.pass)
            .map((c) => (c.detail ? `${c.name} (${c.detail})` : c.name))
            .join(", ") || "none"
        }`,
      );
    }
  }
  lines.push("", "## All transcripts (for language review)");
  for (const result of results) {
    lines.push(
      "",
      `### ${result.passed ? "✅" : "❌"} ${result.modelSpec} · ${result.caseId} (${result.language})`,
    );
    for (const turn of result.turns) lines.push("", `> ${turn.user}`, "", turn.text);
  }
  return `${lines.join("\n")}\n`;
}
