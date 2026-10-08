import { z } from "zod";
import { MoneySchema } from "./money";

export const AvailabilitySchema = z.enum(["in_stock", "low_stock", "out_of_stock", "backorder"]);
export type Availability = z.infer<typeof AvailabilitySchema>;

export const ImageSchema = z.object({ url: z.url(), alt: z.string().optional() });
export type Image = z.infer<typeof ImageSchema>;

export const VariantSchema = z.object({
  id: z.string().min(1),
  productId: z.string().min(1),
  sku: z.string().optional(),
  /** Human label, e.g. "Black / M". */
  title: z.string().min(1),
  /** Option name → value, e.g. { color: "Black", size: "M" }. */
  options: z.record(z.string(), z.string()),
  price: MoneySchema,
  compareAtPrice: MoneySchema.optional(),
  availability: AvailabilitySchema,
});
export type Variant = z.infer<typeof VariantSchema>;

const PriceRangeSchema = z.object({ min: MoneySchema, max: MoneySchema });

export const ProductSchema = z.object({
  id: z.string().min(1),
  handle: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  url: z.url().optional(),
  category: z.string().optional(),
  tags: z.array(z.string()),
  /** Normalised attributes for filtering, e.g. { color: ["black"], occasion: ["wedding"] }. */
  attributes: z.record(z.string(), z.array(z.string())),
  images: z.array(ImageSchema),
  options: z.array(z.object({ name: z.string().min(1), values: z.array(z.string()).min(1) })),
  variants: z.array(VariantSchema).min(1),
  priceRange: PriceRangeSchema,
  updatedAt: z.iso.datetime(),
});
export type Product = z.infer<typeof ProductSchema>;

export const ProductSummarySchema = z.object({
  id: z.string().min(1),
  handle: z.string().min(1),
  title: z.string().min(1),
  url: z.url().optional(),
  image: ImageSchema.optional(),
  priceRange: PriceRangeSchema,
  availability: AvailabilitySchema,
  /** Variants that satisfied the search filters. */
  matchingVariantIds: z.array(z.string()),
});
export type ProductSummary = z.infer<typeof ProductSummarySchema>;

export const SearchProductsInputSchema = z.object({
  query: z.string().trim().max(200).optional(),
  filters: z
    .object({
      category: z.string().optional(),
      /** Option name → accepted values (any-of), e.g. { size: ["M", "L"] }. */
      options: z.record(z.string(), z.array(z.string()).min(1)).optional(),
      /** Minor units, in the store currency. Inclusive. */
      priceMin: z.number().int().nonnegative().optional(),
      priceMax: z.number().int().nonnegative().optional(),
      inStockOnly: z.boolean().optional(),
    })
    .refine((f) => f.priceMin === undefined || f.priceMax === undefined || f.priceMin <= f.priceMax, {
      message: "priceMin must be <= priceMax",
    })
    .default({}),
  limit: z.number().int().min(1).max(50).default(10),
  cursor: z.string().optional(),
});
export type SearchProductsInput = z.input<typeof SearchProductsInputSchema>;
export type SearchFilters = z.output<typeof SearchProductsInputSchema>["filters"];

export const SearchProductsResultSchema = z.object({
  items: z.array(ProductSummarySchema),
  nextCursor: z.string().nullable(),
});
export type SearchProductsResult = z.infer<typeof SearchProductsResultSchema>;

export const ListProductsInputSchema = z.object({
  /** Inclusive lower bound on Product.updatedAt. */
  updatedSince: z.iso.datetime().optional(),
  limit: z.number().int().min(1).max(250).default(100),
  cursor: z.string().optional(),
});
export type ListProductsInput = z.input<typeof ListProductsInputSchema>;

export const ListProductsResultSchema = z.object({
  items: z.array(ProductSchema),
  nextCursor: z.string().nullable(),
});
export type ListProductsResult = z.infer<typeof ListProductsResultSchema>;

const AVAILABILITY_RANK: readonly Availability[] = ["in_stock", "low_stock", "backorder", "out_of_stock"];

/** Best availability across variants; out_of_stock for an empty list. */
export function aggregateAvailability(values: Availability[]): Availability {
  for (const candidate of AVAILABILITY_RANK) {
    if (values.includes(candidate)) return candidate;
  }
  return "out_of_stock";
}

/**
 * Summarise a product for search results. Availability and price range describe the
 * matching variants only (default: all variants). Unknown ids are ignored; if no listed id
 * matches a variant, all variants are used. The result shares no objects with `product`.
 */
export function summarizeProduct(
  product: Product,
  matchingVariantIds: string[] = product.variants.map((variant) => variant.id),
): ProductSummary {
  const listed = new Set(matchingVariantIds);
  const matched = product.variants.filter((variant) => listed.has(variant.id));
  const variants = matched.length > 0 ? matched : product.variants;
  const currency = product.priceRange.min.currency;
  const amounts = variants.map((variant) => variant.price.amount);
  const image = product.images[0];
  return {
    id: product.id,
    handle: product.handle,
    title: product.title,
    url: product.url,
    image: image ? { ...image } : undefined,
    priceRange: {
      min: { amount: Math.min(...amounts), currency },
      max: { amount: Math.max(...amounts), currency },
    },
    availability: aggregateAvailability(variants.map((variant) => variant.availability)),
    matchingVariantIds: variants.map((variant) => variant.id),
  };
}
