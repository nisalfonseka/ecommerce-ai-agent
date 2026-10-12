export const MAX_USER_MESSAGE_CHARS = 2000;

export function checkUserMessage(text: string): { ok: true } | { ok: false; reason: "empty" | "too_long" } {
  if (text.trim().length === 0) return { ok: false, reason: "empty" };
  if (text.length > MAX_USER_MESSAGE_CHARS) return { ok: false, reason: "too_long" };
  return { ok: true };
}

const NUMBER = String.raw`(\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d+(?:\.\d{1,2})?)`;
const PREFIX = String.raw`(?:lkr|rs\.?|රු\.?|රුපියල්|ரூ\.?|ரூபாய்)`;
// Tamil and Sinhala often put the currency word after the number ("18,500 ரூபாய்", "18,500 රුපියල්").
const SUFFIX = String.raw`(?:\/=|\/-|rupees?|lkr|රුපියල්|රු\.?|ரூபாய்|ரூ\.?)`;
// The lookbehind stops "rs" inside words ("colours 3") from counting as Rs.
const BEFORE = new RegExp(String.raw`(?<!\p{L})${PREFIX}\s*${NUMBER}`, "giu");
const AFTER = new RegExp(String.raw`${NUMBER}\s*${SUFFIX}`, "giu");

function toMinor(raw: string): number {
  return Math.round(Number.parseFloat(raw.replaceAll(",", "")) * 100);
}

/** Currency amounts written in the text (LKR/Rs./රු./ரூ./rupees, "/=" suffix), in minor units, in order of appearance. */
export function extractPriceMentions(text: string): number[] {
  const found: { index: number; amount: number }[] = [];
  const seen = new Set<number>();
  for (const pattern of [BEFORE, AFTER]) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[1];
      const numberIndex = raw === undefined ? -1 : (match.index ?? 0) + match[0].indexOf(raw);
      if (raw === undefined || seen.has(numberIndex)) continue;
      seen.add(numberIndex);
      found.push({ index: numberIndex, amount: toMinor(raw) });
    }
  }
  return found.sort((a, b) => a.index - b.index).map((entry) => entry.amount);
}

/**
 * Replaces each price mention whose amount is not in `allowed` with `replacement`. A prefix and a suffix around
 * the same number ("Rs. 25,000/=") are replaced together. Used when a regenerated reply is still ungrounded:
 * the product cards carry the real prices.
 */
export function scrubPrices(text: string, allowed: ReadonlySet<number>, replacement: string): string {
  const spans = new Map<number, { start: number; end: number; amount: number }>();
  for (const pattern of [BEFORE, AFTER]) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[1];
      if (raw === undefined) continue;
      const start = match.index ?? 0;
      const numberIndex = start + match[0].indexOf(raw);
      const end = start + match[0].length;
      const span = spans.get(numberIndex);
      spans.set(numberIndex, {
        start: Math.min(span?.start ?? start, start),
        end: Math.max(span?.end ?? end, end),
        amount: toMinor(raw),
      });
    }
  }
  let result = text;
  for (const span of [...spans.values()].sort((a, b) => b.start - a.start)) {
    if (!allowed.has(span.amount))
      result = result.slice(0, span.start) + replacement + result.slice(span.end);
  }
  return result;
}

const ANY_NUMBER = new RegExp(NUMBER, "g");

/**
 * Every number the shopper wrote, read as rupees, in minor units. Shoppers rarely write a currency ("under
 * 20,000"), and a reply that repeats the shopper's own budget is not a hallucinated store price.
 */
export function shopperAmounts(text: string): number[] {
  return [...text.matchAll(ANY_NUMBER)].flatMap((match) =>
    match[1] === undefined ? [] : [toMinor(match[1])],
  );
}

export function findUngroundedAmounts(text: string, observed: ReadonlySet<number>): number[] {
  return extractPriceMentions(text).filter((amount) => !observed.has(amount));
}
