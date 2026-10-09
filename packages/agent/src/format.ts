import type { Money } from "@ace/contracts";

/** Display string for the model and UI, e.g. "LKR 18,500.00". Assumes a 2-decimal currency (LKR, USD). */
export function formatMoney(value: Money): string {
  const sign = value.amount < 0 ? "-" : "";
  const abs = Math.abs(value.amount);
  const major = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const minor = (abs % 100).toString().padStart(2, "0");
  return `${sign}${value.currency} ${major}.${minor}`;
}

export function formatPriceRange(range: { min: Money; max: Money }): string {
  return range.min.amount === range.max.amount
    ? formatMoney(range.min)
    : `${formatMoney(range.min)} – ${formatMoney(range.max)}`;
}

/** Shopper-facing amounts (rupees) → minor units. */
export function toMinorUnits(major: number | undefined): number | undefined {
  return major === undefined ? undefined : Math.round(major * 100);
}
