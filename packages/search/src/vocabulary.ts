import { z } from "zod";

/** Closed lists (lowercase English). Filters and the lexicon map into these; enrichment may use nothing else. */
export const VOCAB = {
  category: [
    "dress",
    "saree",
    "shirt",
    "t-shirt",
    "blouse",
    "top",
    "kurta",
    "trousers",
    "jeans",
    "shorts",
    "skirt",
    "frock",
    "sarong",
    "jacket",
    "kids",
    "accessory",
  ],
  color: [
    "black",
    "white",
    "red",
    "maroon",
    "pink",
    "orange",
    "yellow",
    "green",
    "olive",
    "blue",
    "navy",
    "purple",
    "brown",
    "beige",
    "cream",
    "grey",
    "gold",
    "silver",
    "multicolor",
  ],
  pattern: ["solid", "floral", "striped", "checked", "printed", "embroidered", "batik", "polka"],
  fabric: [
    "cotton",
    "linen",
    "silk",
    "satin",
    "chiffon",
    "georgette",
    "denim",
    "polyester",
    "rayon",
    "wool",
    "batik",
  ],
  occasion: ["casual", "office", "party", "wedding", "festival", "beach", "sport", "sleep", "religious"],
  fit: ["slim", "regular", "relaxed", "oversized"],
  gender: ["women", "men", "unisex", "girls", "boys"],
  season: ["all", "summer", "rainy"],
} as const;

export type VocabKey = keyof typeof VOCAB;
export const VOCAB_KEYS = Object.keys(VOCAB) as [VocabKey, ...VocabKey[]];

export const EnrichedAttributesSchema = z.object({
  category: z.enum(VOCAB.category).nullable(),
  color: z.array(z.enum(VOCAB.color)).max(3),
  pattern: z.enum(VOCAB.pattern).nullable(),
  fabric: z.array(z.enum(VOCAB.fabric)).max(2),
  occasion: z.array(z.enum(VOCAB.occasion)).max(4),
  fit: z.enum(VOCAB.fit).nullable(),
  gender: z.enum(VOCAB.gender).nullable(),
  season: z.enum(VOCAB.season).nullable(),
});
export type EnrichedAttributes = z.infer<typeof EnrichedAttributesSchema>;

/**
 * `attributes` replaces the effective values of the keys it names (an empty array clears the key);
 * `hidden` and `boost` are stored in their own columns.
 */
export const MerchantOverridesSchema = z.object({
  attributes: z.partialRecord(z.enum(VOCAB_KEYS), z.array(z.string().min(1).max(40)).max(10)).optional(),
  hidden: z.boolean().optional(),
  boost: z.number().min(-1).max(1).optional(),
});
export type MerchantOverrides = z.infer<typeof MerchantOverridesSchema>;

/**
 * The shape stored in `catalog_products.enriched` and read by the attribute merge: one string array per
 * key. Nulls are dropped and scalars wrapped, e.g. `{ category: "dress", pattern: null }` becomes
 * `{ category: ["dress"] }`. Single place for this conversion.
 */
export function flattenEnriched(enriched: EnrichedAttributes): Record<string, string[]> {
  const flat: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(enriched)) {
    const values = Array.isArray(value) ? value : value === null ? [] : [value];
    if (values.length > 0) flat[key] = values;
  }
  return flat;
}
