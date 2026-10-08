import { describe, expect, it } from "vitest";
import {
  aggregateAvailability,
  ListProductsInputSchema,
  ProductSchema,
  ProductSummarySchema,
  SearchProductsInputSchema,
  summarizeProduct,
} from "./catalog";
import { InventoryLevelSchema } from "./inventory";
import { sampleProduct, sampleVariant } from "./test-fixtures";

describe("ProductSchema", () => {
  it("accepts a well-formed product", () => {
    expect(ProductSchema.parse(sampleProduct())).toEqual(sampleProduct());
  });

  it("rejects a product without variants", () => {
    expect(ProductSchema.safeParse(sampleProduct({ variants: [] })).success).toBe(false);
  });

  it("rejects fractional prices", () => {
    const variant = sampleVariant({ price: { amount: 10.5, currency: "LKR" } });
    expect(ProductSchema.safeParse(sampleProduct({ variants: [variant] })).success).toBe(false);
  });
});

describe("SearchProductsInputSchema", () => {
  it("applies defaults", () => {
    expect(SearchProductsInputSchema.parse({})).toEqual({ filters: {}, limit: 10 });
  });

  it("trims the query", () => {
    expect(SearchProductsInputSchema.parse({ query: "  black dress " }).query).toBe("black dress");
  });

  it("caps the page size at 50", () => {
    expect(SearchProductsInputSchema.safeParse({ limit: 51 }).success).toBe(false);
  });

  it("rejects priceMin greater than priceMax", () => {
    const result = SearchProductsInputSchema.safeParse({ filters: { priceMin: 5000, priceMax: 100 } });
    expect(result.success).toBe(false);
  });

  it("rejects negative and fractional price filters", () => {
    expect(SearchProductsInputSchema.safeParse({ filters: { priceMax: -1 } }).success).toBe(false);
    expect(SearchProductsInputSchema.safeParse({ filters: { priceMax: 10.5 } }).success).toBe(false);
  });
});

describe("ListProductsInputSchema", () => {
  it("defaults to 100 and caps at 250", () => {
    expect(ListProductsInputSchema.parse({}).limit).toBe(100);
    expect(ListProductsInputSchema.safeParse({ limit: 251 }).success).toBe(false);
  });
});

describe("aggregateAvailability", () => {
  it("returns the best availability across variants", () => {
    expect(aggregateAvailability(["out_of_stock", "low_stock"])).toBe("low_stock");
    expect(aggregateAvailability(["low_stock", "in_stock"])).toBe("in_stock");
    expect(aggregateAvailability(["out_of_stock", "backorder"])).toBe("backorder");
    expect(aggregateAvailability([])).toBe("out_of_stock");
  });
});

describe("summarizeProduct", () => {
  it("summarises with all variants matching by default", () => {
    const summary = summarizeProduct(sampleProduct());
    expect(summary).toMatchObject({
      id: "prod_dress",
      title: "Black Satin Wrap Dress",
      availability: "in_stock",
      matchingVariantIds: ["var_dress_m"],
      image: { url: "https://demo-store.test/images/dress.jpg" },
    });
  });

  const twoVariantProduct = () => {
    const m = sampleVariant({ id: "var_m", title: "Black / M", price: { amount: 1000, currency: "LKR" } });
    const l = sampleVariant({
      id: "var_l",
      title: "Black / L",
      options: { color: "Black", size: "L" },
      price: { amount: 1200, currency: "LKR" },
      availability: "out_of_stock",
    });
    return sampleProduct({
      variants: [m, l],
      priceRange: { min: { amount: 1000, currency: "LKR" }, max: { amount: 1200, currency: "LKR" } },
    });
  };

  it("reports availability and price for the matching variants only", () => {
    const summary = summarizeProduct(twoVariantProduct(), ["var_l"]);
    expect(summary.availability).toBe("out_of_stock");
    expect(summary.priceRange).toEqual({
      min: { amount: 1200, currency: "LKR" },
      max: { amount: 1200, currency: "LKR" },
    });
    expect(summary.matchingVariantIds).toEqual(["var_l"]);
  });

  it("defaults to all variants", () => {
    const summary = summarizeProduct(twoVariantProduct());
    expect(summary.availability).toBe("in_stock");
    expect(summary.priceRange.min.amount).toBe(1000);
    expect(summary.priceRange.max.amount).toBe(1200);
  });

  it("ignores unknown ids and falls back to all variants when none match", () => {
    const withUnknown = summarizeProduct(twoVariantProduct(), ["var_l", "nope"]);
    expect(withUnknown.priceRange.min.amount).toBe(1200);
    const noneMatch = summarizeProduct(twoVariantProduct(), ["nope"]);
    expect(noneMatch.availability).toBe("in_stock");
    expect(noneMatch.priceRange.min.amount).toBe(1000);
    expect(noneMatch.priceRange.max.amount).toBe(1200);
  });

  it("produces output that parses with ProductSummarySchema", () => {
    expect(ProductSummarySchema.safeParse(summarizeProduct(twoVariantProduct(), ["var_l"])).success).toBe(
      true,
    );
  });

  it("returns copies, not references into the product", () => {
    const product = sampleProduct();
    const summary = summarizeProduct(product);
    summary.priceRange.min.amount = 1;
    summary.priceRange.max.amount = 2;
    if (summary.image) summary.image.url = "https://changed.test/x.jpg";
    expect(product.priceRange.min.amount).toBe(1850000);
    expect(product.priceRange.max.amount).toBe(1850000);
    expect(product.variants[0]?.price.amount).toBe(1850000);
    expect(product.images[0]?.url).toBe("https://demo-store.test/images/dress.jpg");
  });
});

describe("InventoryLevelSchema", () => {
  it("allows hidden quantities as null", () => {
    const level = { variantId: "v1", availability: "in_stock", quantityAvailable: null };
    expect(InventoryLevelSchema.parse(level)).toEqual(level);
  });
});
