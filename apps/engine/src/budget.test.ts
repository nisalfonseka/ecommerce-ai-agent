import { describe, expect, it } from "vitest";
import { budgetState, chooseModel, costMicros, loadModelPrices } from "./budget";

const prices = loadModelPrices({
  models: {
    "test:priced": {
      inputPerMTokUsdMicros: 300_000,
      outputPerMTokUsdMicros: 2_500_000,
      source: "test",
      checkedOn: "2026-10-09",
    },
    "test:unpriced": {
      inputPerMTokUsdMicros: null,
      outputPerMTokUsdMicros: null,
      source: "https://example.test",
      checkedOn: null,
    },
  },
});

const bot = {
  model: "test:priced",
  cheapModel: "test:cheap",
  budgetSoftUsdMicros: 1_000_000,
  budgetHardUsdMicros: 2_000_000,
};

describe("costMicros", () => {
  it("is integer micro-dollars, rounded up", () => {
    // 1,000 input tokens at $0.30/M = 300 micros; 200 output at $2.50/M = 500 micros.
    expect(costMicros(prices, "test:priced", { inputTokens: 1_000, outputTokens: 200 })).toBe(800);
    expect(costMicros(prices, "test:priced", { inputTokens: 1, outputTokens: 0 })).toBe(1);
    expect(costMicros(prices, "test:priced", { inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it("is unknown (null) for unpriced or unlisted models", () => {
    expect(costMicros(prices, "test:unpriced", { inputTokens: 10, outputTokens: 10 })).toBeNull();
    expect(costMicros(prices, "test:missing", { inputTokens: 10, outputTokens: 10 })).toBeNull();
  });
});

describe("budgetState and chooseModel", () => {
  it("moves from ok to alert (80% of soft), soft and hard", () => {
    expect(budgetState(0, bot)).toBe("ok");
    expect(budgetState(799_999, bot)).toBe("ok");
    expect(budgetState(800_000, bot)).toBe("alert");
    expect(budgetState(1_000_000, bot)).toBe("soft");
    expect(budgetState(2_000_000, bot)).toBe("hard");
  });

  it("uses the bot's model, then the cheap model, then contact-only", () => {
    expect(chooseModel(bot, "ok")).toEqual({ model: "test:priced" });
    expect(chooseModel(bot, "alert")).toEqual({ model: "test:priced" });
    expect(chooseModel(bot, "soft")).toEqual({ model: "test:cheap" });
    expect(chooseModel(bot, "hard")).toEqual({ contactOnly: true });
  });
});

describe("loadModelPrices", () => {
  it("rejects malformed price files", () => {
    expect(() => loadModelPrices({ models: { x: { inputPerMTokUsdMicros: -1 } } })).toThrow();
    expect(() =>
      loadModelPrices({
        models: {
          x: { inputPerMTokUsdMicros: 1.5, outputPerMTokUsdMicros: 1, source: "s", checkedOn: null },
        },
      }),
    ).toThrow();
  });
});

describe("the shipped model-prices.json", () => {
  it("is valid and lists only model specs the engine can resolve", async () => {
    const { readFile } = await import("node:fs/promises");
    const { parseModelSpec } = await import("@ace/agent");
    const shipped = loadModelPrices(
      JSON.parse(await readFile(new URL("../model-prices.json", import.meta.url), "utf8")),
    );
    for (const spec of shipped.keys()) {
      if (!spec.startsWith("demo:")) expect(() => parseModelSpec(spec), spec).not.toThrow();
    }
  });
});
