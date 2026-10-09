import type { Product } from "@ace/contracts";
import { CommerceError } from "@ace/contracts";
import { describe, expect, it } from "vitest";
import { searchCatalog } from "./search";
import { defaultSeed } from "./seed";

const products = (): Product[] => defaultSeed().products;
const ids = (result: { items: { id: string }[] }) => result.items.map((item) => item.id);

describe("searchCatalog", () => {
  it("matches words in attributes, case-insensitively", () => {
    expect(ids(searchCatalog(products(), { query: "WEDDING" }))).toEqual(["p_wrap_dress_black"]);
  });

  it("ranks products matching more query words first", () => {
    expect(ids(searchCatalog(products(), { query: "black dress" }))[0]).toBe("p_wrap_dress_black");
  });

  it("returns nothing when no word matches", () => {
    expect(searchCatalog(products(), { query: "tuxedo" })).toEqual({ items: [], nextCursor: null });
  });

  it("filters by category and option values", () => {
    const result = searchCatalog(products(), {
      filters: { category: "Shirt", options: { size: ["XL"] } },
    });
    expect(ids(result)).toEqual(["p_oxford_shirt_white"]);
    expect(result.items[0]?.matchingVariantIds).toEqual(["p_oxford_shirt_white_xl"]);
  });

  it("applies inclusive price bounds in minor units", () => {
    const result = searchCatalog(products(), { filters: { priceMin: 590000, priceMax: 650000 } });
    expect(ids(result).sort()).toEqual(["p_linen_shirt_black", "p_oxford_shirt_white"]);
  });

  it("excludes out-of-stock variants when inStockOnly is set", () => {
    const catalog = products().map((product) => ({
      ...product,
      variants: product.variants.map((variant) => ({ ...variant, availability: "out_of_stock" as const })),
    }));
    expect(searchCatalog(catalog, { filters: { inStockOnly: true } }).items).toEqual([]);
  });

  it("pages with an opaque cursor", () => {
    const first = searchCatalog(products(), { query: "black", limit: 2 });
    expect(first.items).toHaveLength(2);
    const second = searchCatalog(products(), {
      query: "black",
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...ids(first), ...ids(second)]).size).toBe(3);
  });

  it("rejects invalid input with INVALID_INPUT", () => {
    expect(() => searchCatalog(products(), { limit: 0 })).toThrow(CommerceError);
    expect(() => searchCatalog(products(), { cursor: "garbage!" })).toThrow(CommerceError);
  });
});
