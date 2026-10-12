import {
  type Product,
  type SearchFilters,
  type SearchProductsResult,
  summarizeProduct,
  type Variant,
} from "@ace/contracts";

export function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

function productWords(product: Product): Set<string> {
  return new Set(
    words(
      [
        product.title,
        product.description,
        product.category ?? "",
        ...product.tags,
        ...Object.values(product.attributes).flat(),
        ...product.variants.flatMap((variant) => Object.values(variant.options)),
      ].join(" "),
    ),
  );
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

/**
 * Ranks candidate products by query-word overlap and applies the contract's filters to their variants. Medusa's
 * own `q` only finds the candidates; this keeps ranking and filters identical to the memory adapter. The Phase 6
 * search index replaces this for large catalogs.
 */
export function rankProducts(
  products: Product[],
  query: { words: string[]; filters: SearchFilters; offset: number; limit: number },
): { items: SearchProductsResult["items"]; total: number } {
  const category = query.filters.category?.toLowerCase();
  const matches: { product: Product; variantIds: string[]; score: number }[] = [];
  for (const product of products) {
    if (category !== undefined && product.category?.toLowerCase() !== category) continue;
    const variantIds = product.variants
      .filter((variant) => variantMatches(variant, query.filters))
      .map((variant) => variant.id);
    if (variantIds.length === 0) continue;
    let score = 0;
    if (query.words.length > 0) {
      const haystack = productWords(product);
      score = query.words.filter((word) => haystack.has(word)).length;
      if (score === 0) continue;
    }
    matches.push({ product, variantIds, score });
  }
  matches.sort((a, b) => b.score - a.score || a.product.title.localeCompare(b.product.title));
  return {
    items: matches
      .slice(query.offset, query.offset + query.limit)
      .map((match) => summarizeProduct(match.product, match.variantIds)),
    total: matches.length,
  };
}

export function encodeCursor(offset: number): string {
  return btoa(`o:${offset}`);
}

/** null for a malformed cursor. */
export function decodeCursor(cursor: string | undefined): number | null {
  if (cursor === undefined) return 0;
  try {
    const match = /^o:(\d+)$/.exec(atob(cursor));
    return match?.[1] === undefined ? null : Number(match[1]);
  } catch {
    return null;
  }
}
