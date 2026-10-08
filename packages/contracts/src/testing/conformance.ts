import { beforeEach, describe, expect, it, type TestContext } from "vitest";
import type { Capability } from "../capabilities";
import { ATTRIBUTION_ATTRIBUTE, type Cart, type CartLine, CartSchema } from "../cart";
import { ListProductsResultSchema, ProductSchema, SearchProductsResultSchema } from "../catalog";
import { CheckoutHandoffSchema } from "../checkout";
import { CommerceError, type CommerceErrorCode } from "../errors";
import type { VerifiedIdentity } from "../identity";
import { InventoryLevelSchema } from "../inventory";
import { OrderSchema } from "../orders";
import type { CommerceProvider } from "../provider";
import type { ConformanceFixtures, ConformanceSubject } from "./fixtures";

let keyCounter = 0;
function writeKey(): { idempotencyKey: string } {
  keyCounter += 1;
  return { idempotencyKey: `conformance-${Date.now()}-${keyCounter}` };
}

async function expectCommerceError(promise: Promise<unknown>, code: CommerceErrorCode): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(CommerceError);
  await expect(promise).rejects.toMatchObject({ code });
}

function onlyLine(cart: Cart): CartLine {
  expect(cart.lines).toHaveLength(1);
  const [line] = cart.lines;
  if (!line) throw new Error("expected exactly one cart line");
  return line;
}

/** Registers the contract test suite every CommerceProvider adapter must pass. */
export function describeProviderConformance(name: string, setup: () => Promise<ConformanceSubject>): void {
  describe(`CommerceProvider conformance: ${name}`, () => {
    let provider: CommerceProvider;
    let f: ConformanceFixtures;

    beforeEach(async () => {
      ({ provider, fixtures: f } = await setup());
    });

    function needs(ctx: TestContext, ...capabilities: Capability[]): void {
      if (!capabilities.every((capability) => provider.capabilities.has(capability))) ctx.skip();
    }

    async function newCart(): Promise<Cart> {
      return provider.createCart({ attributes: { [ATTRIBUTION_ATTRIBUTE]: "conv_conformance" } }, writeKey());
    }

    it("declares a lowercase platform id and at least one capability", () => {
      expect(provider.platform).toMatch(/^[a-z0-9-]+$/);
      expect(provider.capabilities.size).toBeGreaterThan(0);
    });

    // catalog -------------------------------------------------------------

    it("searchProducts returns schema-valid results", async (ctx) => {
      needs(ctx, "catalog.search");
      const result = await provider.searchProducts({ query: f.searchTerm });
      expect(() => SearchProductsResultSchema.parse(result)).not.toThrow();
      expect(result.items.length).toBeGreaterThan(0);
    });

    it("searchProducts pages with limit and cursor without repeating items", async (ctx) => {
      needs(ctx, "catalog.search");
      const first = await provider.searchProducts({ query: f.searchTerm, limit: 1 });
      expect(first.items).toHaveLength(1);
      expect(first.nextCursor).not.toBeNull();
      const second = await provider.searchProducts({
        query: f.searchTerm,
        limit: 1,
        cursor: first.nextCursor ?? undefined,
      });
      expect(second.items).toHaveLength(1);
      expect(second.items[0]?.id).not.toBe(first.items[0]?.id);
    });

    it("searchProducts rejects invalid input with INVALID_INPUT", async (ctx) => {
      needs(ctx, "catalog.search");
      await expectCommerceError(provider.searchProducts({ limit: 500 }), "INVALID_INPUT");
    });

    it("getProduct returns a valid product, and null for an unknown id", async (ctx) => {
      needs(ctx, "catalog.read");
      const product = await provider.getProduct(f.productId);
      expect(product).not.toBeNull();
      expect(() => ProductSchema.parse(product)).not.toThrow();
      expect(await provider.getProduct("does-not-exist-000")).toBeNull();
    });

    it("listProducts returns schema-valid pages", async (ctx) => {
      needs(ctx, "catalog.list");
      const page = await provider.listProducts({ limit: 2 });
      expect(() => ListProductsResultSchema.parse(page)).not.toThrow();
      expect(page.items.length).toBeGreaterThan(0);
    });

    it("getInventory reports in-stock and out-of-stock variants", async (ctx) => {
      needs(ctx, "inventory.read");
      const levels = await provider.getInventory([f.inStockVariantId, f.outOfStockVariantId]);
      for (const level of levels) expect(() => InventoryLevelSchema.parse(level)).not.toThrow();
      const byId = new Map(levels.map((level) => [level.variantId, level]));
      expect(byId.get(f.inStockVariantId)?.availability).toMatch(/^(in_stock|low_stock)$/);
      expect(byId.get(f.outOfStockVariantId)?.availability).toBe("out_of_stock");
    });

    // cart ----------------------------------------------------------------

    it("createCart returns an empty cart that keeps attributes", async (ctx) => {
      needs(ctx, "cart.write");
      const cart = await newCart();
      expect(() => CartSchema.parse(cart)).not.toThrow();
      expect(cart.lines).toHaveLength(0);
      expect(cart.itemCount).toBe(0);
      expect(cart.subtotal.amount).toBe(0);
      expect(cart.attributes[ATTRIBUTION_ATTRIBUTE]).toBe("conv_conformance");
      expect(await provider.getCart(cart.id)).toEqual(cart);
    });

    it("addCartLines adds a line and computes totals", async (ctx) => {
      needs(ctx, "cart.write");
      const cart = await newCart();
      const updated = await provider.addCartLines(
        cart.id,
        { lines: [{ variantId: f.inStockVariantId, quantity: 2 }] },
        writeKey(),
      );
      expect(() => CartSchema.parse(updated)).not.toThrow();
      const line = onlyLine(updated);
      expect(line.variantId).toBe(f.inStockVariantId);
      expect(line.quantity).toBe(2);
      expect(line.lineTotal.amount).toBe(line.unitPrice.amount * 2);
      expect(updated.subtotal.amount).toBe(line.lineTotal.amount);
      expect(updated.itemCount).toBe(2);
    });

    it("adding the same variant twice merges into one line", async (ctx) => {
      needs(ctx, "cart.write");
      const cart = await newCart();
      const line = { lines: [{ variantId: f.inStockVariantId, quantity: 1 }] };
      await provider.addCartLines(cart.id, line, writeKey());
      const updated = await provider.addCartLines(cart.id, line, writeKey());
      expect(onlyLine(updated).quantity).toBe(2);
    });

    it("replaying an idempotency key does not add twice", async (ctx) => {
      needs(ctx, "cart.write");
      const cart = await newCart();
      const opts = writeKey();
      const input = { lines: [{ variantId: f.inStockVariantId, quantity: 1 }] };
      const first = await provider.addCartLines(cart.id, input, opts);
      const replay = await provider.addCartLines(cart.id, input, opts);
      expect(replay.itemCount).toBe(1);
      expect(replay).toEqual(first);
    });

    it("rejects out-of-stock variants and leaves the cart unchanged", async (ctx) => {
      needs(ctx, "cart.write");
      const cart = await newCart();
      await expectCommerceError(
        provider.addCartLines(
          cart.id,
          { lines: [{ variantId: f.outOfStockVariantId, quantity: 1 }] },
          writeKey(),
        ),
        "OUT_OF_STOCK",
      );
      expect((await provider.getCart(cart.id))?.lines).toHaveLength(0);
    });

    it("rejects invalid quantities with INVALID_INPUT", async (ctx) => {
      needs(ctx, "cart.write");
      const cart = await newCart();
      for (const quantity of [0, -1, 1.5, 21]) {
        await expectCommerceError(
          provider.addCartLines(
            cart.id,
            { lines: [{ variantId: f.inStockVariantId, quantity }] },
            writeKey(),
          ),
          "INVALID_INPUT",
        );
      }
    });

    it("returns null / NOT_FOUND for unknown carts and variants", async (ctx) => {
      needs(ctx, "cart.write");
      expect(await provider.getCart("no-such-cart")).toBeNull();
      await expectCommerceError(
        provider.addCartLines(
          "no-such-cart",
          { lines: [{ variantId: f.inStockVariantId, quantity: 1 }] },
          writeKey(),
        ),
        "NOT_FOUND",
      );
      const cart = await newCart();
      await expectCommerceError(
        provider.addCartLines(
          cart.id,
          { lines: [{ variantId: "no-such-variant", quantity: 1 }] },
          writeKey(),
        ),
        "NOT_FOUND",
      );
    });

    it("updateCartLine changes quantity and removes the line at 0", async (ctx) => {
      needs(ctx, "cart.write");
      const cart = await newCart();
      const added = await provider.addCartLines(
        cart.id,
        { lines: [{ variantId: f.inStockVariantId, quantity: 1 }] },
        writeKey(),
      );
      const lineId = onlyLine(added).id;
      const changed = await provider.updateCartLine(cart.id, { lineId, quantity: 2 }, writeKey());
      expect(onlyLine(changed).quantity).toBe(2);
      const removed = await provider.updateCartLine(cart.id, { lineId, quantity: 0 }, writeKey());
      expect(removed.lines).toHaveLength(0);
      expect(removed.subtotal.amount).toBe(0);
    });

    // checkout ------------------------------------------------------------

    it("createCheckout returns CONFLICT for an empty cart and a handoff URL otherwise", async (ctx) => {
      needs(ctx, "cart.write", "checkout.handoff");
      const cart = await newCart();
      await expectCommerceError(provider.createCheckout(cart.id, writeKey()), "CONFLICT");
      await provider.addCartLines(
        cart.id,
        { lines: [{ variantId: f.inStockVariantId, quantity: 1 }] },
        writeKey(),
      );
      const handoff = await provider.createCheckout(cart.id, writeKey());
      expect(() => CheckoutHandoffSchema.parse(handoff)).not.toThrow();
      expect(handoff.cartId).toBe(cart.id);
    });

    // orders --------------------------------------------------------------

    it("lookupOrder returns the order to its owner and null to anyone else", async (ctx) => {
      needs(ctx, "orders.lookup");
      const order = await provider.lookupOrder({ orderNumber: f.orderNumber, identity: f.orderOwner });
      expect(order).not.toBeNull();
      expect(() => OrderSchema.parse(order)).not.toThrow();
      expect(await provider.lookupOrder({ orderNumber: f.orderNumber, identity: f.stranger })).toBeNull();
      expect(await provider.lookupOrder({ orderNumber: "NO-SUCH-ORDER", identity: f.orderOwner })).toBeNull();
    });

    it("lookupOrder rejects an identity without identifiers", async (ctx) => {
      needs(ctx, "orders.lookup");
      const empty = { method: "email_otp", verifiedAt: new Date().toISOString() } as VerifiedIdentity;
      await expectCommerceError(
        provider.lookupOrder({ orderNumber: f.orderNumber, identity: empty }),
        "INVALID_INPUT",
      );
    });

    it("listOrders only returns orders owned by the identity", async (ctx) => {
      needs(ctx, "orders.lookup");
      const mine = await provider.listOrders({ identity: f.orderOwner });
      expect(mine.map((order) => order.number)).toContain(f.orderNumber);
      expect(await provider.listOrders({ identity: f.stranger })).toEqual([]);
    });
  });
}
