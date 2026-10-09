import { describe, expect, it } from "vitest";
import { formatMoney, formatPriceRange, toMinorUnits } from "./format";

describe("format", () => {
  it("formats minor units with grouping and two decimals", () => {
    expect(formatMoney({ amount: 1850000, currency: "LKR" })).toBe("LKR 18,500.00");
    expect(formatMoney({ amount: 5, currency: "LKR" })).toBe("LKR 0.05");
    expect(formatMoney({ amount: 123456789, currency: "LKR" })).toBe("LKR 1,234,567.89");
    expect(formatMoney({ amount: -650000, currency: "LKR" })).toBe("-LKR 6,500.00");
  });

  it("collapses equal ranges", () => {
    const m = { amount: 650000, currency: "LKR" };
    expect(formatPriceRange({ min: m, max: m })).toBe("LKR 6,500.00");
    expect(formatPriceRange({ min: m, max: { amount: 700000, currency: "LKR" } })).toBe(
      "LKR 6,500.00 – LKR 7,000.00",
    );
  });

  it("converts major units to minor units", () => {
    expect(toMinorUnits(20000)).toBe(2000000);
    expect(toMinorUnits(18500.5)).toBe(1850050);
    expect(toMinorUnits(undefined)).toBeUndefined();
  });
});
