import { EVAL_QUERIES } from "./queries";
import type { RelevanceReport } from "./run";

const fixed = (value: number) => value.toFixed(3);

/** Markdown: overall and per-language nDCG@5, the `worst` lowest queries with their graded top 5, and probes. */
export function renderRelevanceReport(
  report: RelevanceReport,
  options: { title: string; models: string[]; probes?: { query: string; top: string[] }[]; worst?: number },
): string {
  const byId = new Map(EVAL_QUERIES.map((query) => [query.id, query]));
  const worst = [...report.perQuery].sort((a, b) => a.ndcg - b.ndcg).slice(0, options.worst ?? 10);
  const lines = [
    `# ${options.title}`,
    "",
    ...options.models.map((model) => `- ${model}`),
    "",
    "| Overall | " + Object.keys(report.byLang).join(" | ") + " |",
    `|---|${Object.keys(report.byLang)
      .map(() => "---")
      .join("|")}|`,
    `| ${fixed(report.overall)} | ${Object.values(report.byLang).map(fixed).join(" | ")} |`,
    "",
    `## Worst ${worst.length} queries`,
    "",
    "| Query | Lang | nDCG@5 | Input | Top 5 (grade) |",
    "|---|---|---|---|---|",
    ...worst.map((row) => {
      const query = byId.get(row.id);
      const graded = row.top.map((id) => `${id} (${query?.relevant[id] ?? 0})`).join(", ");
      return `| ${row.id} | ${query?.lang ?? ""} | ${fixed(row.ndcg)} | ${JSON.stringify(query?.input ?? {})} | ${graded || "–"} |`;
    }),
  ];
  if (options.probes) {
    lines.push("", "## Off-catalog probes (not scored)", "", "| Query | Top 5 |", "|---|---|");
    for (const probe of options.probes) lines.push(`| ${probe.query} | ${probe.top.join(", ") || "–"} |`);
  }
  return `${lines.join("\n")}\n`;
}
