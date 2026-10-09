import { CommerceError, type Money } from "@ace/contracts";

/** ISO 4217 minor-unit exponents that differ from 2. */
const EXPONENTS: Record<string, number> = {
  BIF: 0,
  CLP: 0,
  DJF: 0,
  GNF: 0,
  ISK: 0,
  JPY: 0,
  KMF: 0,
  KRW: 0,
  PYG: 0,
  RWF: 0,
  UGX: 0,
  VND: 0,
  VUV: 0,
  XAF: 0,
  XOF: 0,
  XPF: 0,
  BHD: 3,
  IQD: 3,
  JOD: 3,
  KWD: 3,
  LYD: 3,
  OMR: 3,
  TND: 3,
};

/** Medusa v2 amounts are major units ("18500.00" LKR); the contract wants integer minor units. */
export function toMoney(amount: number, currencyCode: string): Money {
  const currency = currencyCode.toUpperCase();
  const minor = Math.round(amount * 10 ** (EXPONENTS[currency] ?? 2));
  if (!Number.isFinite(minor)) {
    throw new CommerceError("UPSTREAM_UNAVAILABLE", "The store sent an invalid amount.", { currency });
  }
  return { amount: minor, currency };
}
