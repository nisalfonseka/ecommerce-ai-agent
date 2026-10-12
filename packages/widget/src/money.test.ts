import { describe, expect, it } from "vitest";
import { formatMoney, formatPriceRange } from "./money";

describe("formatMoney", () => {
  it("matches the agent's format so text and cards agree", () => {
    expect(formatMoney({ amount: 1850000, currency: "LKR" })).toBe("LKR 18,500.00");
    expect(formatMoney({ amount: 5, currency: "LKR" })).toBe("LKR 0.05");
    expect(
      formatPriceRange({
        min: { amount: 650000, currency: "LKR" },
        max: { amount: 700000, currency: "LKR" },
      }),
    ).toBe("LKR 6,500.00 – LKR 7,000.00");
  });
});
