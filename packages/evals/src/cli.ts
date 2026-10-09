import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { hasApiKey, PROVIDER_ENV_KEYS, parseModelSpec, resolveModel } from "@ace/agent";
import { ALL_CASES } from "./cases/index";
import { parseCliArgs } from "./cli-args";
import { DEFAULT_EVAL_MODELS, EVAL_PERSONA, EVAL_STORE } from "./config";
import { renderMarkdown, summarize } from "./report";
import { runCase } from "./runner";
import type { CaseResult } from "./types";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

try {
  process.loadEnvFile(resolve(repoRoot, ".env"));
} catch {
  // No .env: rely on the shell environment.
}

const args = parseCliArgs(process.argv.slice(2));
const only = args.only;
const cases = ALL_CASES.filter(
  (c) => only === null || c.language === only || c.tags.includes(only) || c.id.startsWith(only),
);
const results: CaseResult[] = [];

for (const spec of args.models ?? DEFAULT_EVAL_MODELS) {
  const { provider } = parseModelSpec(spec);
  if (!hasApiKey(provider)) {
    console.log(`skip ${spec} (no ${PROVIDER_ENV_KEYS[provider]})`);
    continue;
  }
  const model = resolveModel(spec);
  for (const evalCase of cases) {
    const result = await runCase(evalCase, {
      model,
      modelSpec: spec,
      persona: EVAL_PERSONA,
      store: EVAL_STORE,
    });
    results.push(result);
    console.log(
      `${result.passed ? "PASS" : "FAIL"} ${spec} ${evalCase.id}${result.error ? ` (${result.error})` : ""}`,
    );
  }
}

const summaries = summarize(results);
const out = resolve(
  repoRoot,
  args.out ?? `evals-reports/${new Date().toISOString().replaceAll(":", "-")}.md`,
);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, renderMarkdown(results, summaries));
console.table(
  summaries.map((s) => ({
    model: s.modelSpec,
    pass: `${s.passed}/${s.cases}`,
    rate: `${Math.round(s.passRate * 100)}%`,
    inTok: s.inputTokens,
    outTok: s.outputTokens,
    avgMs: s.avgTurnLatencyMs,
  })),
);
console.log(`Report: ${out}`);
