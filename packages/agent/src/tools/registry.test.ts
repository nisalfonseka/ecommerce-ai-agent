import { MemoryCommerceProvider } from "@ace/adapter-memory";
import type { Capability, CommerceProvider } from "@ace/contracts";
import { describe, expect, it } from "vitest";
import { createToolContext } from "../context";
import { ALL_TOOLS, buildTools } from "./registry";

describe("buildTools", () => {
  it("registers every tool for a provider with every capability", () => {
    const ctx = createToolContext({
      provider: new MemoryCommerceProvider(),
      conversationId: "c",
      turnId: "t",
    });
    expect(Object.keys(buildTools(ctx)).sort()).toEqual(
      [
        "add_to_cart",
        "check_availability",
        "get_product",
        "lookup_order",
        "search_products",
        "start_checkout",
        "update_cart_line",
        "view_cart",
      ].sort(),
    );
    expect(ALL_TOOLS).toHaveLength(8);
  });

  it("hides tools whose capabilities the provider does not declare", () => {
    const base = new MemoryCommerceProvider();
    const readOnly: CommerceProvider = Object.assign(Object.create(base), {
      capabilities: new Set<Capability>(["catalog.search", "catalog.read"]),
    });
    const ctx = createToolContext({ provider: readOnly, conversationId: "c", turnId: "t" });
    expect(Object.keys(buildTools(ctx)).sort()).toEqual(["get_product", "search_products"]);
  });
});

describe("unexpected errors", () => {
  // One input per tool that reaches a provider call.
  const inputs: Record<string, unknown> = {
    search_products: { query: "dress" },
    get_product: { productId: "p" },
    check_availability: { productId: "p" },
    view_cart: {},
    add_to_cart: { variantId: "v", quantity: 1 },
    update_cart_line: { lineId: "l", quantity: 1 },
    start_checkout: {},
    lookup_order: { orderNumber: "ACE-1001" },
  };

  it("every tool reports non-commerce errors to the hook and hides them from the model", async () => {
    const base = new MemoryCommerceProvider();
    const broken: CommerceProvider = Object.assign(Object.create(base), {
      searchProducts: () => Promise.reject(new Error("socket hang up")),
      getProduct: () => Promise.reject(new Error("socket hang up")),
      getCart: () => Promise.reject(new Error("socket hang up")),
      updateCartAttributes: () => Promise.reject(new Error("socket hang up")),
      updateCartLine: () => Promise.reject(new Error("socket hang up")),
      createCheckout: () => Promise.reject(new Error("socket hang up")),
      lookupOrder: () => Promise.reject(new Error("socket hang up")),
    });
    const reported: string[] = [];
    for (const def of ALL_TOOLS) {
      const ctx = createToolContext({
        provider: broken,
        conversationId: "c",
        turnId: "t",
        cartId: "cart_1",
        identity: {
          method: "email_otp",
          email: "customer@example.com",
          verifiedAt: "2026-10-01T00:00:00.000Z",
        },
        onUnexpectedError: () => reported.push(def.name),
      });
      const result = await def.run(ctx, def.inputSchema.parse(inputs[def.name]), "c1");
      expect(result, def.name).toMatchObject({ ok: false, error: { code: "UPSTREAM_UNAVAILABLE" } });
      expect(JSON.stringify(result), def.name).not.toContain("socket hang up");
    }
    expect(reported.sort()).toEqual(Object.keys(inputs).sort());
  });
});
