import { MemoryCommerceProvider } from "@ace/adapter-memory";
import { describe, expect, it } from "vitest";
import { createToolContext } from "../context";
import { checkAvailabilityTool, getProductTool, searchProductsTool } from "./catalog";

const make = () =>
  createToolContext({ provider: new MemoryCommerceProvider(), conversationId: "conv", turnId: "t1" });

describe("search_products", () => {
  it("returns numbered, formatted results and records them in the session and UI", async () => {
    const ctx = make();
    const result = await searchProductsTool.run(
      ctx,
      { query: "dress", color: "black", maxPrice: 20000, inStockOnly: true },
      "c1",
    );
    expect(result).toEqual({
      ok: true,
      data: {
        items: [
          {
            ref: "#1",
            productId: "p_wrap_dress_black",
            title: "Black Satin Wrap Dress",
            price: "LKR 18,500.00",
            availability: "in_stock",
          },
        ],
        more: false,
      },
    });
    expect(ctx.session.shown.map((s) => s.ref)).toEqual(["#1"]);
    expect(ctx.ui[0]?.type).toBe("product_list");
    expect(ctx.observedAmounts.has(1850000)).toBe(true);
  });

  it("filters by size and reports the matching variants' availability", async () => {
    const ctx = make();
    const result = await searchProductsTool.run(ctx, { query: "linen", size: "L" }, "c1");
    expect(result.ok && result.data.items[0]).toMatchObject({
      title: "Black Linen Shirt",
      availability: "out_of_stock",
    });
  });

  it("returns an empty list when nothing matches", async () => {
    const ctx = make();
    expect(await searchProductsTool.run(ctx, { query: "tuxedo" }, "c1")).toEqual({
      ok: true,
      data: { items: [], more: false },
    });
  });
});

describe("get_product", () => {
  it("resolves a ref from the last search and returns variants with prices", async () => {
    const ctx = make();
    await searchProductsTool.run(ctx, { query: "black" }, "c1");
    const second = ctx.session.shown[1];
    const result = await getProductTool.run(ctx, { ref: "#2" }, "c2");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.productId).toBe(second?.productId);
      expect(result.data.variants[0]).toHaveProperty("price");
    }
    expect(ctx.ui.at(-1)?.type).toBe("product_detail");
  });

  it("fails with UNKNOWN_REF for a ref that was not shown", async () => {
    const ctx = make();
    const result = await getProductTool.run(ctx, { ref: "#7" }, "c1");
    expect(result).toMatchObject({ ok: false, error: { code: "UNKNOWN_REF" } });
  });

  it("fails with NOT_FOUND for an unknown product id", async () => {
    const result = await getProductTool.run(make(), { productId: "nope" }, "c1");
    expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });
});

describe("check_availability", () => {
  it("reads live inventory for the requested size", async () => {
    const result = await checkAvailabilityTool.run(
      make(),
      { productId: "p_wrap_dress_black", size: "L" },
      "c1",
    );
    expect(result).toEqual({
      ok: true,
      data: {
        productId: "p_wrap_dress_black",
        variants: [
          {
            variantId: "p_wrap_dress_black_l",
            title: "Black / L",
            availability: "low_stock",
            quantityAvailable: 1,
          },
        ],
      },
    });
  });

  it("keeps a null count from stores that hide exact stock", async () => {
    const base = new MemoryCommerceProvider();
    const provider = Object.assign(Object.create(base), {
      getInventory: async (ids: string[]) =>
        (await base.getInventory(ids)).map((level) => ({ ...level, quantityAvailable: null })),
    });
    const ctx = createToolContext({ provider, conversationId: "conv", turnId: "t1" });
    const result = await checkAvailabilityTool.run(ctx, { productId: "p_wrap_dress_black", size: "L" }, "c1");
    expect(result.ok && result.data.variants[0]?.quantityAvailable).toBeNull();
  });

  it("lists every variant when no option is given", async () => {
    const result = await checkAvailabilityTool.run(make(), { productId: "p_linen_shirt_black" }, "c1");
    expect(result.ok && result.data.variants.map((v) => v.availability)).toEqual([
      "in_stock",
      "in_stock",
      "out_of_stock",
    ]);
  });
});
