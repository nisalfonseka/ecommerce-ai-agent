import { MemoryCommerceProvider } from "@ace/adapter-memory";
import { SearchProductsInputSchema } from "@ace/contracts";
import { createDb } from "@ace/db";
import { createTestDatabase, type TestDatabase } from "@ace/db/testing";
import { createDemoEmbedder } from "@ace/knowledge";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDemoEnricher } from "../enrich";
import { normalizeQuery, tokenize } from "../query";
import { newTenantStore } from "../test-fixture";
import { VOCAB } from "../vocabulary";
import { ENRICHMENT_ONLY, EVAL_PRODUCTS, evalSeed, NEAR_DUPLICATES } from "./catalog";
import { EVAL_QUERIES } from "./queries";
import { renderRelevanceReport } from "./report";
import { type RelevanceReport, runOffCatalogProbes, runRelevanceEval } from "./run";

const specs = new Map(EVAL_PRODUCTS.map((spec) => [spec.id, spec]));
const count = <T>(values: T[]) => {
  const counts = new Map<T, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
};
const hasWord = (text: string, word: string) =>
  new RegExp(`(?<![a-z0-9])${word.replace(/[-]/g, "\\-")}(?:e?s)?(?![a-z0-9])`).test(text.toLowerCase());

describe("eval catalog coverage", () => {
  it("has 80 unique products priced LKR 1,500–45,000, with some sold-out variants and products", async () => {
    expect(EVAL_PRODUCTS).toHaveLength(80);
    expect(specs.size).toBe(80);
    for (const spec of EVAL_PRODUCTS) {
      expect(spec.priceRupees, spec.id).toBeGreaterThanOrEqual(1500);
      expect(spec.priceRupees, spec.id).toBeLessThanOrEqual(45000);
    }
    const store = new MemoryCommerceProvider({ seed: evalSeed() });
    const { items } = await store.listProducts({ limit: 250 });
    const availability = items.flatMap((product) => product.variants.map((variant) => variant.availability));
    expect(availability.filter((value) => value === "out_of_stock").length).toBeGreaterThanOrEqual(10);
    const soldOut = items.filter((product) =>
      product.variants.every((v) => v.availability === "out_of_stock"),
    );
    expect(soldOut.length).toBeGreaterThanOrEqual(2);
  });

  it("covers at least 8 vocabulary categories with 4+ products each", () => {
    const categories = count(EVAL_PRODUCTS.map((spec) => spec.category));
    const covered = VOCAB.category.filter((category) => (categories.get(category) ?? 0) >= 4);
    expect(covered.length).toBeGreaterThanOrEqual(8);
  });

  it("covers 10+ colours and 6+ products each for wedding, office and casual", () => {
    const colours = new Set(EVAL_PRODUCTS.flatMap((spec) => spec.attributes.color ?? []));
    expect(colours.size).toBeGreaterThanOrEqual(10);
    const occasions = count(EVAL_PRODUCTS.flatMap((spec) => spec.attributes.occasion ?? []));
    for (const occasion of ["wedding", "office", "casual"]) {
      expect(occasions.get(occasion) ?? 0, occasion).toBeGreaterThanOrEqual(6);
    }
  });

  it("has 10+ near-duplicate pairs that differ only in colour or fabric", () => {
    expect(NEAR_DUPLICATES.length).toBeGreaterThanOrEqual(10);
    for (const [aId, bId] of NEAR_DUPLICATES) {
      const a = specs.get(aId);
      const b = specs.get(bId);
      if (!a || !b) throw new Error(`unknown pair ${aId} / ${bId}`);
      expect([b.category, b.description, b.sizes], aId).toEqual([a.category, a.description, a.sizes]);
      const { color: _ac, fabric: _af, ...aRest } = a.attributes;
      const { color: _bc, fabric: _bf, ...bRest } = b.attributes;
      expect(bRest, aId).toEqual(aRest);
      const differs =
        JSON.stringify(a.attributes.color) !== JSON.stringify(b.attributes.color) ||
        JSON.stringify(a.attributes.fabric) !== JSON.stringify(b.attributes.fabric);
      expect(differs, aId).toBe(true);
    }
  });

  it("has 15 products whose key attribute only the description carries, and the demo enricher finds it", async () => {
    expect(Object.keys(ENRICHMENT_ONLY)).toHaveLength(15);
    const enricher = createDemoEnricher();
    for (const [id, { key, value }] of Object.entries(ENRICHMENT_ONLY)) {
      const spec = specs.get(id);
      if (!spec) throw new Error(`unknown product ${id}`);
      const elsewhere = [
        spec.title,
        spec.category,
        ...spec.tags,
        ...Object.values(spec.attributes).flat(),
        spec.color,
        ...spec.sizes,
      ];
      for (const text of elsewhere)
        expect(hasWord(text, value), `${id}: "${value}" in "${text}"`).toBe(false);
      expect(hasWord(spec.description, value), id).toBe(true);
      const { attributes } = await enricher.enrich({
        title: spec.title,
        description: spec.description,
        category: spec.category,
        tags: spec.tags,
        attributes: spec.attributes,
        options: { color: [spec.color], size: spec.sizes },
      });
      const found = (attributes as Record<string, unknown>)[key];
      expect(Array.isArray(found) ? found : [found], id).toContain(value);
    }
  });
});

describe("eval queries", () => {
  it("has 50 queries: 22 en, 12 singlish, 8 si, 8 ta, with unique ids and valid inputs", () => {
    expect(EVAL_QUERIES).toHaveLength(50);
    expect(new Set(EVAL_QUERIES.map((query) => query.id)).size).toBe(50);
    expect(Object.fromEntries(count(EVAL_QUERIES.map((query) => query.lang)))).toEqual({
      en: 22,
      singlish: 12,
      si: 8,
      ta: 8,
    });
    for (const query of EVAL_QUERIES)
      expect(() => SearchProductsInputSchema.parse(query.input), query.id).not.toThrow();
  });

  it("has 10+ queries with filters", () => {
    const filtered = EVAL_QUERIES.filter((query) => Object.keys(query.input.filters ?? {}).length > 0);
    expect(filtered.length).toBeGreaterThanOrEqual(10);
  });

  it("grades only catalog products that pass the query's hard filters, with a grade-3 product each", async () => {
    const store = new MemoryCommerceProvider({ seed: evalSeed() });
    for (const query of EVAL_QUERIES) {
      expect(Object.values(query.relevant), query.id).toContain(3);
      const filters = SearchProductsInputSchema.parse(query.input).filters;
      for (const id of Object.keys(query.relevant)) {
        const product = await store.getProduct(id);
        if (!product) throw new Error(`${query.id}: unknown product ${id}`);
        const enrichedCategory =
          ENRICHMENT_ONLY[id]?.key === "category" ? ENRICHMENT_ONLY[id]?.value : undefined;
        if (filters.category !== undefined) {
          expect([product.category, enrichedCategory], `${query.id}: ${id}`).toContain(filters.category);
        }
        const passing = product.variants.filter(
          (variant) =>
            (!filters.inStockOnly || variant.availability !== "out_of_stock") &&
            (filters.priceMin === undefined || variant.price.amount >= filters.priceMin) &&
            (filters.priceMax === undefined || variant.price.amount <= filters.priceMax) &&
            Object.entries(filters.options ?? {}).every(([name, values]) =>
              values.includes(variant.options[name] ?? ""),
            ),
        );
        expect(passing.length, `${query.id}: ${id} fails the filters`).toBeGreaterThan(0);
      }
    }
  });

  it("has 5+ paraphrases sharing no keyword with any grade-3 product's title or category", () => {
    const stopwords = new Set(["a", "an", "the", "for", "to", "in", "of", "on", "and", "with"]);
    const paraphrases = EVAL_QUERIES.filter((query) => query.paraphrase);
    expect(paraphrases.length).toBeGreaterThanOrEqual(5);
    for (const query of paraphrases) {
      const terms = normalizeQuery(query.input.query ?? "").terms.filter((term) => !stopwords.has(term));
      for (const [id, grade] of Object.entries(query.relevant)) {
        if (grade !== 3) continue;
        const spec = specs.get(id);
        const words = new Set(tokenize(`${spec?.title ?? ""} ${spec?.category ?? ""}`));
        expect(
          terms.filter((term) => words.has(term)),
          `${query.id}: ${id}`,
        ).toEqual([]);
      }
    }
  });
});

const testDb = await createTestDatabase();

describe.skipIf(testDb === null)("search relevance (demo embedder + demo enricher)", () => {
  let database: TestDatabase;
  let app: ReturnType<typeof createDb>;
  let report: RelevanceReport;
  let store: { tenantId: string; storeId: string };
  const embedder = createDemoEmbedder();

  beforeAll(async () => {
    if (!testDb) return;
    database = testDb;
    app = createDb(database.appUrl);
    store = await newTenantStore(app.db);
    report = await runRelevanceEval({ db: app.db, ...store, embedder, enricher: createDemoEnricher() });
  }, 600_000);
  afterAll(async () => {
    await app?.close();
    await database?.drop();
  });

  it("meets the CI floor nDCG@5 ≥ 0.70 (S3)", async () => {
    const probes = await runOffCatalogProbes({ db: app.db, ...store, embedder });
    console.log(
      renderRelevanceReport(report, {
        title: "Search relevance (demo models)",
        models: [embedder.model, createDemoEnricher().model],
        probes,
      }),
    );
    expect(report.perQuery).toHaveLength(50);
    expect(report.overall).toBeGreaterThanOrEqual(0.7);
  }, 120_000);
});
