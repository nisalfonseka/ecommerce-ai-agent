import { describe, expect, it } from "vitest";
import { CommerceError } from "./errors";
import { addMoney, money, multiplyMoney } from "./money";

describe("money", () => {
  it("stores integer minor units", () => {
    expect(money(650000, "LKR")).toEqual({ amount: 650000, currency: "LKR" });
  });

  it("rejects fractional amounts", () => {
    expect(() => money(12.5, "LKR")).toThrow(CommerceError);
  });

  it("rejects currency codes that are not 3 uppercase letters", () => {
    expect(() => money(100, "rs")).toThrow(CommerceError);
    expect(() => money(100, "lkr")).toThrow(CommerceError);
  });

  it("adds same-currency amounts", () => {
    expect(addMoney(money(100, "LKR"), money(250, "LKR"))).toEqual(money(350, "LKR"));
  });

  it("refuses to add different currencies", () => {
    expect(() => addMoney(money(100, "LKR"), money(1, "USD"))).toThrow(CommerceError);
  });

  it("multiplies by integer factors only", () => {
    expect(multiplyMoney(money(700, "LKR"), 3)).toEqual(money(2100, "LKR"));
    expect(() => multiplyMoney(money(700, "LKR"), 1.5)).toThrow(CommerceError);
  });
});
