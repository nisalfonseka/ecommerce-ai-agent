/**
 * Owner-gated live relevance eval (Task 8 Step 4): real embedding and enrichment models against a fresh database
 * on ACE_TEST_DATABASE_URL. Needs API keys and costs money, so it never runs in CI and no test imports it.
 *
 *   pnpm search-evals --embedding google:gemini-embedding-001 --enrichment google:gemini-flash-lite-latest
 *
 * Writes evals-reports/search-<date>.md (overall, per language, worst 10 queries with their top 5, probes).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  hasApiKey,
  PROVIDER_ENV_KEYS,
  parseModelSpec,
  resolveEmbeddingModel,
  resolveModel,
} from "@ace/agent";
import { createDb, createStore, createTenant, withTenant } from "@ace/db";
import { createTestDatabase } from "@ace/db/testing";
import { embedderFor } from "@ace/knowledge";
import { parseStoreSearchConfig } from "../config";
import { createDemoEnricher, createLlmEnricher, type Enricher } from "../enrich";
import { renderRelevanceReport } from "./report";
import { runOffCatalogProbes, runRelevanceEval } from "./run";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
for (const file of [".env", ".env.test.local"]) {
  try {
    process.loadEnvFile(resolve(repoRoot, file));
  } catch {
    // Missing file: rely on the shell environment.
  }
}

function parseArgs(argv: string[]): { embedding: string; enrichment: string; out: string | null } {
  // Defaults are the store config defaults (S1), never a second hard-coded copy.
  const defaults = parseStoreSearchConfig({});
  const args = {
    embedding: defaults.embeddingModel,
    enrichment: defaults.enrichmentModel,
    out: null as string | null,
  };
  const tokens = argv.filter((token) => token !== "--");
  for (let index = 0; index < tokens.length; index += 2) {
    const flag = tokens[index];
    const value = tokens[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    if (flag === "--embedding") args.embedding = value;
    else if (flag === "--enrichment") args.enrichment = value;
    else if (flag === "--out") args.out = value;
    else throw new Error(`Unknown flag ${flag}. Use --embedding, --enrichment, --out.`);
  }
  return args;
}

function requireKey(spec: string): void {
  if (spec.startsWith("demo:")) return;
  const { provider } = parseModelSpec(spec);
  if (!hasApiKey(provider))
    throw new Error(`${spec} needs ${PROVIDER_ENV_KEYS[provider]} (in .env or the shell).`);
}

const args = parseArgs(process.argv.slice(2));
requireKey(args.embedding);
requireKey(args.enrichment);
const embedder = embedderFor(args.embedding, { allowDemo: true, resolve: resolveEmbeddingModel });
const enricher: Enricher = args.enrichment.startsWith("demo:")
  ? createDemoEnricher()
  : createLlmEnricher(args.enrichment, resolveModel(args.enrichment));

const database = await createTestDatabase();
if (!database) throw new Error("ACE_TEST_DATABASE_URL is not set (see .env.test.local).");
const app = createDb(database.appUrl);
try {
  const { tenantId } = await createTenant(app.db, { name: "Search relevance eval" });
  const storeId = await withTenant(
    app.db,
    tenantId,
    async (tx) => (await createStore(tx, tenantId, { platform: "memory", currency: "LKR" })).id,
  );
  console.log(`Indexing 80 products with ${embedder.model} + ${enricher.model} …`);
  const report = await runRelevanceEval({ db: app.db, tenantId, storeId, embedder, enricher });
  const probes = await runOffCatalogProbes({ db: app.db, tenantId, storeId, embedder });
  const out = resolve(
    repoRoot,
    args.out ?? `evals-reports/search-${new Date().toISOString().slice(0, 10)}.md`,
  );
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    renderRelevanceReport(report, {
      title: "Search relevance eval (nDCG@5)",
      models: [`embedding: ${embedder.model}`, `enrichment: ${enricher.model}`],
      probes,
    }),
  );
  console.table({ overall: report.overall, ...report.byLang });
  console.log(`Report: ${out}`);
} finally {
  await app.close();
  await database.drop();
}
