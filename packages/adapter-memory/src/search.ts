import {
  type Product,
  parseInput,
  type SearchFilters,
  type SearchProductsInput,
  SearchProductsInputSchema,
  type SearchProductsResult,
  summarizeProduct,
  type Variant,
} from "@ace/contracts";
import { decodeCursor, encodeCursor } from "./cursor";

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

function productWords(product: Product): Set<string> {
  const text = [
    product.title,
    product.description,
    product.category ?? "",
    ...product.tags,
    ...Object.values(product.attributes).flat(),
    ...product.variants.flatMap((variant) => Object.values(variant.options)),
  ].join(" ");
  return new Set(words(text));
}

function variantMatches(variant: Variant, filters: SearchFilters): boolean {
  if (filters.inStockOnly && variant.availability === "out_of_stock") return false;
  if (filters.priceMin !== undefined && variant.price.amount < filters.priceMin) return false;
  if (filters.priceMax !== undefined && variant.price.amount > filters.priceMax) return false;
  for (const [name, accepted] of Object.entries(filters.options ?? {})) {
    const actual = variant.options[name]?.toLowerCase();
    if (actual === undefined || !accepted.some((value) => value.toLowerCase() === actual)) return false;
  }
  return true;
}

/** Simple word-overlap search used by the in-memory adapter. Real adapters use platform or index search. */
export function searchCatalog(products: Product[], input: SearchProductsInput): SearchProductsResult {
  const query = parseInput(SearchProductsInputSchema, input);
  const offset = decodeCursor(query.cursor);
  const queryWords = query.query ? words(query.query) : [];
  const category = query.filters.category?.toLowerCase();

  const matches: { product: Product; variantIds: string[]; score: number }[] = [];
  for (const product of products) {
    if (category !== undefined && product.category?.toLowerCase() !== category) continue;
    const variantIds = product.variants
      .filter((variant) => variantMatches(variant, query.filters))
      .map((variant) => variant.id);
    if (variantIds.length === 0) continue;
    let score = 0;
    if (queryWords.length > 0) {
      const haystack = productWords(product);
      score = queryWords.filter((word) => haystack.has(word)).length;
      if (score === 0) continue;
    }
    matches.push({ product, variantIds, score });
  }

  matches.sort((a, b) => b.score - a.score || a.product.title.localeCompare(b.product.title));
  const page = matches.slice(offset, offset + query.limit);
  const nextOffset = offset + page.length;
  return {
    items: page.map((match) => summarizeProduct(match.product, match.variantIds)),
    nextCursor: nextOffset < matches.length ? encodeCursor(nextOffset) : null,
  };
}
