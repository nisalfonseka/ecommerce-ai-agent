import { CartSchema, OrderSchema, ProductSchema } from "@ace/contracts";
import { describe, expect, it } from "vitest";
import cartJson from "./__fixtures__/cart.json" with { type: "json" };
import orderJson from "./__fixtures__/order.json" with { type: "json" };
import productJson from "./__fixtures__/product.json" with { type: "json" };
import { orderOwner, toCart, toOrder, toProduct, variantStock } from "./mapping";
import { MedusaCart, MedusaOrder, MedusaProduct } from "./responses";

const product = MedusaProduct.parse(productJson);
const cart = MedusaCart.parse(cartJson);
const order = MedusaOrder.parse(orderJson);
const ctx = { storefrontUrl: "https://shop.example.lk", currency: "LKR" };

describe("toProduct", () => {
  it("maps a Medusa product to a schema-valid contract product with minor units and live stock", () => {
    const mapped = toProduct(product, ctx);
    expect(() => ProductSchema.parse(mapped)).not.toThrow();
    expect(mapped).toMatchObject({
      id: product.id,
      handle: "linen-shirt-black",
      title: "Black Linen Shirt",
      url: "https://shop.example.lk/products/linen-shirt-black",
      category: "shirt",
      tags: ["men", "summer"],
      attributes: { fabric: ["linen"] },
      options: [
        { name: "color", values: ["Black"] },
        { name: "size", values: ["S", "M", "L"] },
      ],
      priceRange: { min: { amount: 650000, currency: "LKR" }, max: { amount: 650000, currency: "LKR" } },
    });
    expect(mapped?.variants.map((v) => [v.title, v.options, v.availability])).toEqual([
      ["Black / S", { color: "Black", size: "S" }, "in_stock"],
      ["Black / M", { color: "Black", size: "M" }, "in_stock"],
      ["Black / L", { color: "Black", size: "L" }, "out_of_stock"],
    ]);
    expect(mapped?.updatedAt).toMatch(/Z$/);
  });

  it("drops variants without a price in the region, and the product if none is left", () => {
    const unpriced = {
      ...product,
      variants: product.variants?.map((v) => ({ ...v, calculated_price: null })),
    };
    expect(toProduct(unpriced, ctx)).toBeNull();
  });

  it("ignores malformed attribute metadata and image URLs", () => {
    const odd = {
      ...product,
      metadata: { attributes: "nope" },
      images: [{ url: "not a url" }],
      thumbnail: null,
    };
    expect(toProduct(odd, ctx)).toMatchObject({ attributes: {}, images: [] });
  });
});

describe("variantStock", () => {
  it("derives availability from inventory, backorders and unmanaged stock", () => {
    expect(variantStock({ id: "v", manage_inventory: true, inventory_quantity: 5 })).toEqual({
      availability: "in_stock",
      quantityAvailable: 5,
    });
    expect(variantStock({ id: "v", manage_inventory: true, inventory_quantity: 2 }).availability).toBe(
      "low_stock",
    );
    expect(variantStock({ id: "v", manage_inventory: true, inventory_quantity: 0 }).availability).toBe(
      "out_of_stock",
    );
    expect(
      variantStock({ id: "v", manage_inventory: true, inventory_quantity: -1, allow_backorder: true }),
    ).toEqual({ availability: "backorder", quantityAvailable: 0 });
    expect(variantStock({ id: "v", manage_inventory: false })).toEqual({
      availability: "in_stock",
      quantityAvailable: null,
    });
  });
});

describe("toCart", () => {
  it("maps lines, totals in minor units and string attributes", () => {
    const mapped = toCart({ ...cart, metadata: { ...cart.metadata, count: 3 } });
    expect(() => CartSchema.parse(mapped)).not.toThrow();
    expect(mapped.attributes).toEqual({ ace_conversation_id: "conv_1" });
    expect(mapped.lines[0]).toMatchObject({
      title: "Black Satin Wrap Dress",
      variantTitle: "Black / M",
      quantity: 1,
      unitPrice: { amount: 1850000, currency: "LKR" },
      lineTotal: { amount: 1850000, currency: "LKR" },
    });
    expect(mapped.subtotal).toEqual({ amount: 1850000, currency: "LKR" });
    expect(mapped.itemCount).toBe(1);
  });
});

describe("toOrder", () => {
  it("maps an order without exposing addresses", () => {
    const mapped = toOrder(order);
    expect(() => OrderSchema.parse(mapped)).not.toThrow();
    expect(mapped).toMatchObject({
      number: String(order.display_id),
      status: "pending",
      paymentStatus: "pending",
      total: { amount: 1850000, currency: "LKR" },
      lines: [{ title: "Black Satin Wrap Dress", variantTitle: "Black / S", quantity: 1 }],
      tracking: [],
    });
    expect(JSON.stringify(mapped)).not.toContain("+9477");
  });

  it("maps cash on delivery, payment and fulfilment states", () => {
    const cod = {
      ...order,
      payment_status: "authorized",
      payment_collections: [{ payments: [{ provider_id: "pp_system_default" }] }],
    };
    expect(toOrder(cod)).toMatchObject({ status: "confirmed", paymentStatus: "cod_pending" });
    const paid = {
      ...order,
      payment_status: "captured",
      fulfillment_status: "shipped",
      fulfillments: [{ labels: [{ tracking_number: "DC1", tracking_url: "https://track.example/DC1" }] }],
    };
    expect(toOrder(paid)).toMatchObject({
      status: "shipped",
      paymentStatus: "paid",
      tracking: [{ carrier: "Courier", number: "DC1", url: "https://track.example/DC1" }],
    });
    expect(toOrder({ ...order, status: "canceled" })?.status).toBe("cancelled");
    expect(toOrder({ ...order, fulfillment_status: "delivered" })?.status).toBe("delivered");
  });

  it("names the order's owners for identity checks", () => {
    expect(orderOwner(order)).toEqual({
      email: "customer@example.com",
      phone: "+94771234567",
      externalCustomerId: order.customer_id ?? undefined,
    });
  });
});
