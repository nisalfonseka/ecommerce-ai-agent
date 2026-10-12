import { createHash } from "node:crypto";
import type { SearchFilters } from "@ace/contracts";
import { LEXICON, SUFFIX_RULES } from "./lexicon";
import { stableJson } from "./stable-json";

/**
 * Like the demo embedder's tokens (a letter, then letters, combining marks and digits), plus U+200D (ZWJ) inside a
 * word: Sinhala conjuncts such as ෆ්\u200dරොක් use it, and splitting there would break lexicon matches.
 */
const TOKEN = /\p{L}[\p{L}\p{M}\p{N}\u200d]*/gu;

const MAX_PHRASE_WORDS = Math.max(...Object.keys(LEXICON).map((key) => key.split(" ").length));

/** NFKC, lowercase words; punctuation and spaces dropped. */
export function tokenize(text: string): string[] {
  return text.normalize("NFKC").toLowerCase().match(TOKEN) ?? [];
}

/** Own keys only: shopper text like "constructor" must not read Object.prototype members. */
function lexiconEntry(key: string): string | undefined {
  return Object.hasOwn(LEXICON, key) ? LEXICON[key] : undefined;
}

/** A lexicon word, or an inflected form of one (SUFFIX_RULES); the stem must keep at least two characters. */
function lookupWord(word: string): string | undefined {
  const direct = lexiconEntry(word);
  if (direct !== undefined) return direct;
  for (const { suffix, replacement } of SUFFIX_RULES) {
    if (word.length >= suffix.length + 2 && word.endsWith(suffix)) {
      const stem = lexiconEntry(word.slice(0, -suffix.length) + replacement);
      if (stem !== undefined) return stem;
    }
  }
  return undefined;
}

/**
 * NFKC, lowercase, tokenise, then map lexicon phrases (longest match first) and words to catalog vocabulary.
 * Unknown words pass through. `text` is the rewritten query; `terms` its unique words, in order.
 */
export function normalizeQuery(text: string): { text: string; terms: string[] } {
  const tokens = tokenize(text);
  const out: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    let consumed = 0;
    for (let size = Math.min(MAX_PHRASE_WORDS, tokens.length - i); size >= 1; size--) {
      const phrase = tokens.slice(i, i + size).join(" ");
      const mapped = size === 1 ? lookupWord(phrase) : lexiconEntry(phrase);
      if (mapped !== undefined) {
        out.push(mapped);
        consumed = size;
        break;
      }
    }
    if (consumed === 0) {
      out.push(tokens[i] ?? "");
      consumed = 1;
    }
    i += consumed;
  }
  return { text: out.join(" "), terms: [...new Set(out)] };
}

/** Binds a cursor to the search that issued it: 12 hex chars of sha256 over the query and filters. */
export function queryFingerprint(query: string | undefined, filters: SearchFilters): string {
  return createHash("sha256")
    .update(stableJson({ query: query ?? null, filters }))
    .digest("hex")
    .slice(0, 12);
}
