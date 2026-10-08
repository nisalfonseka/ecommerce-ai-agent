import { describe, expect, it } from "vitest";
import {
  aggregateAvailability,
  ListProductsInputSchema,
  ProductSchema,
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
});

describe("InventoryLevelSchema", () => {
  it("allows hidden quantities as null", () => {
    const level = { variantId: "v1", availability: "in_stock", quantityAvailable: null };
    expect(InventoryLevelSchema.parse(level)).toEqual(level);
  });
});
