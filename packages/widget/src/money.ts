export interface Money {
  amount: number;
  currency: string;
}

/** Same output as the agent's formatMoney ("LKR 18,500.00"), so reply text and cards agree. */
export function formatMoney(value: Money): string {
  const sign = value.amount < 0 ? "-" : "";
  const abs = Math.abs(value.amount);
  const major = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${value.currency} ${major}.${(abs % 100).toString().padStart(2, "0")}`;
}

export function formatPriceRange(range: { min: Money; max: Money }): string {
  return range.min.amount === range.max.amount
    ? formatMoney(range.min)
    : `${formatMoney(range.min)} – ${formatMoney(range.max)}`;
}
