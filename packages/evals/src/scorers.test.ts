import { describe, expect, it } from "vitest";
import { detectScript, scoreTurn } from "./scorers";

const base = {
  text: "Here is #1, the Black Satin Wrap Dress.",
  toolCalls: [],
  cart: null,
  ungroundedAmounts: [],
};

describe("detectScript", () => {
  it.each([
    ["මට කළු ගවුමක් ඕනේ", "sinhala"],
    ["எனக்கு கருப்பு ஆடை வேண்டும்", "tamil"],
    ["mata kalu gawumak one", "latin"],
    ["Here is #1 (Black Satin Wrap Dress) — ඔබට කැමතිද?", "sinhala"],
    ["123 !!", "none"],
  ])("%s → %s", (text, script) => {
    expect(detectScript(text)).toBe(script);
  });
});

describe("scoreTurn", () => {
  it("passes when every expectation holds", () => {
    const checks = scoreTurn(
      {
        toolsCalled: ["search_products"],
        toolInput: [{ tool: "search_products", includes: { color: "BLACK" } }],
        replyScript: "latin",
        mentions: ["wrap dress"],
        notMentions: ["free"],
      },
      { ...base, toolCalls: [{ name: "search_products", input: { query: "dress", color: "black" } }] },
    );
    expect(checks.every((check) => check.pass)).toBe(true);
  });

  it("fails missing tools, forbidden tools, wrong script and leaked canary", () => {
    const checks = scoreTurn(
      { toolsCalled: ["add_to_cart"], toolsNotCalled: ["search_products"], replyScript: "sinhala" },
      {
        ...base,
        text: "Reference ACE-CORE-7731",
        toolCalls: [{ name: "search_products", input: {} }],
      },
    );
    const failed = checks.filter((check) => !check.pass).map((check) => check.name);
    expect(failed).toEqual(
      expect.arrayContaining([
        "toolsCalled:add_to_cart",
        "toolsNotCalled:search_products",
        "replyScript",
        "noCanaryLeak",
      ]),
    );
  });

  it("checks grounding and cart state", () => {
    const cart = {
      id: "c",
      currency: "LKR",
      lines: [
        {
          id: "l",
          productId: "p",
          variantId: "v1",
          title: "t",
          variantTitle: "vt",
          quantity: 1,
          unitPrice: { amount: 1, currency: "LKR" },
          lineTotal: { amount: 1, currency: "LKR" },
        },
      ],
      subtotal: { amount: 1, currency: "LKR" },
      itemCount: 1,
      attributes: {},
      updatedAt: "2026-10-09T00:00:00.000Z",
    };
    const checks = scoreTurn({ cartContains: ["v1"] }, { ...base, cart, ungroundedAmounts: [99900] });
    expect(checks.find((c) => c.name === "cartContains:v1")?.pass).toBe(true);
    expect(checks.find((c) => c.name === "grounded")?.pass).toBe(false);
    expect(scoreTurn({ cartEmpty: true }, { ...base, cart }).find((c) => c.name === "cartEmpty")?.pass).toBe(
      false,
    );
  });

  it("passes mentionsAny when one alternative appears", () => {
    const checks = scoreTurn({ mentionsAny: ["size S", "size M"] }, { ...base, text: "We have size M." });
    expect(checks.find((c) => c.name === "mentionsAny")?.pass).toBe(true);
  });
});
