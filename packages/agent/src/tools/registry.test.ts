import { MemoryCommerceProvider } from "@ace/adapter-memory";
import type { Capability, CommerceProvider } from "@ace/contracts";
import { describe, expect, it } from "vitest";
import { runTurn } from "../agent";
import { createToolContext } from "../context";
import { createSession } from "../session";
import { callTool, say, scriptedModel } from "../testing";
import { ACTION_TOOLS, ALL_TOOLS, buildTools } from "./registry";

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
    expect(ALL_TOOLS).toHaveLength(9);
  });

  it("adds start_cod_order only when the tenant enabled cash on delivery", () => {
    const ctx = createToolContext({
      provider: new MemoryCommerceProvider(),
      conversationId: "c",
      turnId: "t",
      cod: { maxTotal: null, allowedCities: null, countryCode: "LK" },
    });
    expect(Object.keys(buildTools(ctx))).toContain("start_cod_order");
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
    start_cod_order: {},
    cod_quote: {
      name: "Nimali",
      phone: "0771234567",
      address: { line1: "12 Galle Road", city: "Colombo", countryCode: "LK" },
    },
    place_cod_order: {},
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
      quoteCodOrder: () => Promise.reject(new Error("socket hang up")),
    });
    const reported: string[] = [];
    const lkr = (amount: number) => ({ amount, currency: "LKR" });
    for (const def of [...ALL_TOOLS, ...ACTION_TOOLS]) {
      const session = createSession();
      session.codDraft = {
        cartId: "cart_1",
        details: {
          name: "Nimali",
          phone: "+94771234567",
          address: { line1: "12 Galle Road", city: "Colombo", countryCode: "LK" },
        },
        subtotal: lkr(100),
        deliveryFee: lkr(0),
        total: lkr(100),
        itemCount: 1,
      };
      const ctx = createToolContext({
        provider: broken,
        conversationId: "c",
        turnId: "t",
        cartId: "cart_1",
        session,
        cod: { maxTotal: null, allowedCities: null, countryCode: "LK" },
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

describe("tool log and status hook", () => {
  it("records each call's name, duration and outcome, and announces it first", async () => {
    let clock = 1_000;
    const started: string[] = [];
    const ctx = createToolContext({
      provider: new MemoryCommerceProvider(),
      conversationId: "c",
      turnId: "t",
      onToolStart: (name) => {
        started.push(name);
        clock += 5;
      },
      now: () => clock,
    });
    await runTurn({
      model: scriptedModel([
        callTool("c1", "search_products", { query: "dress" }),
        callTool("c2", "get_product", { ref: "#9" }),
        say("Done."),
      ]),
      ctx,
      persona: { assistantName: "Nila", storeName: "Demo", languages: ["English"] },
      store: { currency: "LKR" },
      history: [],
      userMessage: "dresses",
    });
    expect(started).toEqual(["search_products", "get_product"]);
    expect(ctx.toolLog.map(({ name, ok, errorCode }) => ({ name, ok, errorCode }))).toEqual([
      { name: "search_products", ok: true, errorCode: undefined },
      { name: "get_product", ok: false, errorCode: "UNKNOWN_REF" },
    ]);
    expect(ctx.toolLog[1]?.startedAt).toBe(1_010);
  });
});
