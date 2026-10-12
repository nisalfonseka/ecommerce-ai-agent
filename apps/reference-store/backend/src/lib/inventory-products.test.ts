import { describe, expect, it, vi } from "vitest";
import { productIdsForInventoryLevel } from "./inventory-products";

describe("productIdsForInventoryLevel", () => {
  it("resolves level to item to distinct products", async () => {
    const graph = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id: "lev_1", inventory_item_id: "iitem_1" }] })
      .mockResolvedValueOnce({
        data: [
          { id: "iitem_1", variants: [{ product_id: "p_1" }, { product_id: "p_1" }, { product_id: "p_2" }] },
        ],
      });
    expect(await productIdsForInventoryLevel({ graph }, "lev_1")).toEqual(["p_1", "p_2"]);
    expect(graph.mock.calls[1]?.[0]).toMatchObject({
      entity: "inventory_item",
      filters: { id: ["iitem_1"] },
    });
  });

  it("returns nothing for an unknown level", async () => {
    const graph = vi.fn().mockResolvedValueOnce({ data: [] });
    expect(await productIdsForInventoryLevel({ graph }, "nope")).toEqual([]);
    expect(graph).toHaveBeenCalledTimes(1);
  });
});
