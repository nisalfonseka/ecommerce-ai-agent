import { describe, expect, it } from "vitest";
import { CodDetailsSchema, CodQuoteSchema } from "./cod";

const details = {
  name: "  Nimali Perera ",
  phone: "077 123 4567",
  address: { line1: "12 Galle Road", city: "Colombo 03", countryCode: "LK" },
};

describe("CodDetailsSchema", () => {
  it("trims text and normalises the phone", () => {
    expect(CodDetailsSchema.parse(details)).toEqual({
      name: "Nimali Perera",
      phone: "+94771234567",
      address: { line1: "12 Galle Road", city: "Colombo 03", countryCode: "LK" },
    });
  });

  it("rejects missing or oversized fields", () => {
    expect(CodDetailsSchema.safeParse({ ...details, name: " " }).success).toBe(false);
    expect(CodDetailsSchema.safeParse({ ...details, phone: "12" }).success).toBe(false);
    expect(CodDetailsSchema.safeParse({ ...details, note: "x".repeat(501) }).success).toBe(false);
    expect(
      CodDetailsSchema.safeParse({ ...details, address: { ...details.address, countryCode: "lk" } }).success,
    ).toBe(false);
    expect(
      CodDetailsSchema.safeParse({ ...details, address: { ...details.address, city: "" } }).success,
    ).toBe(false);
  });
});

describe("CodQuoteSchema", () => {
  const lkr = (amount: number) => ({ amount, currency: "LKR" });
  const quote = {
    cartId: "c1",
    subtotal: lkr(1850000),
    deliveryFee: lkr(40000),
    total: lkr(1890000),
    itemCount: 1,
  };

  it("accepts a quote whose total adds up", () => {
    expect(CodQuoteSchema.parse(quote)).toEqual(quote);
  });

  it("rejects a total that is not subtotal + delivery fee, or mixed currencies", () => {
    expect(CodQuoteSchema.safeParse({ ...quote, total: lkr(1850000) }).success).toBe(false);
    expect(
      CodQuoteSchema.safeParse({ ...quote, deliveryFee: { amount: 40000, currency: "USD" } }).success,
    ).toBe(false);
  });
});
