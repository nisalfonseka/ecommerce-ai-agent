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
