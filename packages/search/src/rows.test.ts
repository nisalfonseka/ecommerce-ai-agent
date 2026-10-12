import { MemoryCommerceProvider } from "@ace/adapter-memory";
import { describe, expect, it } from "vitest";
import { contentHash, embeddingHash, embeddingText, productRows } from "./rows";

const provider = new MemoryCommerceProvider();
const shirt = await provider.getProduct("p_linen_shirt_black");
if (!shirt) throw new Error("seed missing");

describe("productRows", () => {
  it("lowercases option keys and takes prices and availability from variants", () => {
    const { product, variants } = productRows("store-1", shirt);
    expect(variants.map((v) => v.optionKeys)).toContainEqual(["color:black", "size:s"]);
    expect(product.minPrice).toBe(Math.min(...shirt.variants.map((v) => v.price.amount)));
    expect(product.maxPrice).toBe(Math.max(...shirt.variants.map((v) => v.price.amount)));
    expect(product.currency).toBe(shirt.priceRange.min.currency);
    expect(product.availability).toBe("in_stock");
    expect(variants.find((v) => v.title === "Black / L")?.availability).toBe("out_of_stock");
    expect(product.searchPrimary).toBe(shirt.title);
  });

  it("merges effective attributes: overrides replace a key, enriched unions with platform values", () => {
    const platform = { ...shirt, attributes: { color: ["Black"] } };
    const { product } = productRows("s", platform, {
      enriched: { color: ["Charcoal", "black"], occasion: ["Work"], junk: "nope" },
      overrides: { occasion: ["Wedding"] },
    });
    expect(product.attributes).toEqual({ color: ["black", "charcoal"], occasion: ["wedding"] });
    expect(product.searchSecondary).toContain("wedding");
    expect(product.enriched).toEqual({ color: ["Charcoal", "black"], occasion: ["Work"], junk: "nope" });
  });
});

describe("hashes", () => {
  it("contentHash ignores price and stock but changes with the description", () => {
    const pricier = structuredClone(shirt);
    for (const v of pricier.variants) {
      v.price.amount += 100;
      v.availability = "out_of_stock";
    }
    expect(contentHash(pricier)).toBe(contentHash(shirt));
    expect(contentHash({ ...shirt, description: `${shirt.description} New.` })).not.toBe(contentHash(shirt));
  });

  it("embeddingText follows the documented layout and the hash tracks it", () => {
    const text = embeddingText({
      title: "Shirt",
      category: "Tops",
      attributes: { color: ["black", "white"], fit: ["slim"] },
      tags: ["linen"],
      description: "x".repeat(2000),
    });
    expect(text.startsWith("Shirt. Tops. color: black, white; fit: slim. linen. x")).toBe(true);
    expect(text.length).toBe("Shirt. Tops. color: black, white; fit: slim. linen. ".length + 1500);
    expect(embeddingHash(text)).not.toBe(embeddingHash(`${text}!`));
  });
});
