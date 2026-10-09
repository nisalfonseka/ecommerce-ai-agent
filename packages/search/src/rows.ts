import { createHash } from "node:crypto";
import { aggregateAvailability, type Product } from "@ace/contracts";
import type { CatalogProductInsert, CatalogVariantInsert } from "@ace/db";
import { stableJson } from "./stable-json";

export interface ProductRows {
  product: CatalogProductInsert;
  variants: CatalogVariantInsert[];
}

type Attributes = Record<string, string[]>;

const DESCRIPTION_CHARS = 1500;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const normalise = (values: unknown): string[] =>
  Array.isArray(values)
    ? [
        ...new Set(
          values.filter((v): v is string => typeof v === "string").map((v) => v.trim().toLowerCase()),
        ),
      ]
        .filter((v) => v !== "")
        .sort()
    : [];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Enriched and overrides are opaque JSON from other tasks; non-array values are ignored. */
export function mergeAttributes(platform: Attributes, enriched: unknown, overrides: unknown): Attributes {
  const enrichedRecord = isRecord(enriched) ? enriched : {};
  const overrideRecord = isRecord(overrides) ? overrides : {};
  const keys = new Set([
    ...Object.keys(platform),
    ...Object.keys(enrichedRecord),
    ...Object.keys(overrideRecord),
  ]);
  const merged: Attributes = {};
  for (const key of [...keys].sort()) {
    const override = overrideRecord[key];
    const values = Array.isArray(override)
      ? normalise(override)
      : normalise([...normalise(platform[key]), ...normalise(enrichedRecord[key])]);
    if (values.length > 0) merged[key] = values;
  }
  return merged;
}

/** Sorted and unique so a stored row (which only has its variants) can rebuild the same text. */
export const variantOptionValues = (options: Record<string, string>[]): string[] =>
  [...new Set(options.flatMap((o) => Object.values(o)))].sort();

/** The weight-B full-text field: category, effective attribute values, tags and option values. */
export function searchSecondaryText(parts: {
  category: string | null;
  attributes: Attributes;
  tags: string[];
  optionValues: string[];
}): string {
  return [
    parts.category ?? "",
    ...Object.values(parts.attributes).flat(),
    ...parts.tags,
    ...parts.optionValues,
  ]
    .filter((part) => part !== "")
    .join(" ");
}

export function productRows(
  storeId: string,
  product: Product,
  existing?: { enriched: unknown; overrides: unknown },
): ProductRows {
  const amounts = product.variants.map((variant) => variant.price.amount);
  const attributes = mergeAttributes(product.attributes, existing?.enriched, existing?.overrides);
  const optionValues = variantOptionValues(product.variants.map((variant) => variant.options));
  const searchSecondary = searchSecondaryText({
    category: product.category ?? null,
    attributes,
    tags: product.tags,
    optionValues,
  });
  return {
    product: {
      storeId,
      productId: product.id,
      handle: product.handle,
      title: product.title,
      description: product.description,
      url: product.url ?? null,
      category: product.category ?? null,
      tags: product.tags,
      platformAttributes: product.attributes,
      enriched: existing?.enriched ?? null,
      overrides: existing?.overrides ?? {},
      attributes,
      imageUrl: product.images[0]?.url ?? null,
      currency: product.priceRange.min.currency,
      minPrice: Math.min(...amounts),
      maxPrice: Math.max(...amounts),
      availability: aggregateAvailability(product.variants.map((variant) => variant.availability)),
      searchPrimary: product.title,
      searchSecondary,
      sourceUpdatedAt: new Date(product.updatedAt),
      contentHash: contentHash(product),
    },
    variants: product.variants.map((variant) => ({
      storeId,
      productId: product.id,
      variantId: variant.id,
      title: variant.title,
      options: variant.options,
      optionKeys: Object.entries(variant.options)
        .map(([name, value]) => `${name}:${value}`.toLowerCase())
        .sort(),
      price: variant.price.amount,
      currency: variant.price.currency,
      availability: variant.availability,
    })),
  };
}

/** sha256 of the fields enrichment reads: title, description, category, tags, platform attributes, options. */
export function contentHash(product: Product): string {
  return sha256(
    stableJson({
      title: product.title,
      description: product.description,
      category: product.category ?? null,
      tags: product.tags,
      attributes: product.attributes,
      options: product.options,
    }),
  );
}

export function embeddingText(row: {
  title: string;
  category?: string | null;
  attributes: Record<string, string[]>;
  tags: string[];
  description: string;
}): string {
  const attributes = Object.entries(row.attributes)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, values]) => `${key}: ${values.join(", ")}`)
    .join("; ");
  return [
    row.title,
    row.category ?? "",
    attributes,
    row.tags.join(", "),
    row.description.slice(0, DESCRIPTION_CHARS),
  ]
    .filter((part) => part !== "")
    .join(". ");
}

export const embeddingHash = (text: string): string => sha256(text);
