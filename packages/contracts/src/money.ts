import { z } from "zod";
import { CommerceError, parseInput } from "./errors";

export const CurrencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, "ISO 4217 code, e.g. LKR");

/** Integer amount in the currency's minor unit (LKR 1,250.00 → 125000). Never floats. */
export const MoneySchema = z.object({
  amount: z.number().int(),
  currency: CurrencyCodeSchema,
});

export type Money = z.infer<typeof MoneySchema>;

export function money(amount: number, currency: string): Money {
  return parseInput(MoneySchema, { amount, currency });
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) {
    throw new CommerceError("INVALID_INPUT", `Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
  return { amount: a.amount + b.amount, currency: a.currency };
}

export function multiplyMoney(value: Money, factor: number): Money {
  if (!Number.isInteger(factor)) {
    throw new CommerceError("INVALID_INPUT", "Money can only be multiplied by an integer");
  }
  return { amount: value.amount * factor, currency: value.currency };
}
