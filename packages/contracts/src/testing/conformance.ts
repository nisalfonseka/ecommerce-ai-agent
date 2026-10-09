import { beforeEach, describe, expect, it, type TestContext } from "vitest";
import { CAPABILITIES, type Capability } from "../capabilities";
import { ATTRIBUTION_ATTRIBUTE, type Cart, type CartLine, CartSchema, MAX_LINE_QUANTITY } from "../cart";
import { ListProductsResultSchema, ProductSchema, SearchProductsResultSchema } from "../catalog";
import { CheckoutHandoffSchema } from "../checkout";
import { CommerceError, type CommerceErrorCode } from "../errors";
import type { VerifiedIdentity } from "../identity";
import { InventoryLevelSchema } from "../inventory";
import { OrderSchema } from "../orders";
import type { CommerceProvider } from "../provider";
import type {
  ConformanceControl,
  ConformanceFixtures,
  ConformanceOptions,
  ConformanceSubject,
} from "./fixtures";

let keyCounter = 0;
function writeKey(): { idempotencyKey: string } {
  keyCounter += 1;
  return { idempotencyKey: `conformance-${Date.now()}-${keyCounter}` };
}

async function expectCommerceError(promise: Promise<unknown>, code: CommerceErrorCode): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(CommerceError);
  await expect(promise).rejects.toMatchObject({ code });
}

const UTC_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

function onlyLine(cart: Cart): CartLine {
  expect(cart.lines).toHaveLength(1);
  const [line] = cart.lines;
  if (!line) throw new Error("expected exactly one cart line");
  return line;
}

/**
 * Registers the contract test suite every CommerceProvider adapter must pass.
 *
 * `setup` runs before every test, including ones that end up skipped, and must return a provider with
 * fresh, isolated state so tests cannot affect each other.
 */
export function describeProviderConformance(
  name: string,
  setup: () => Promise<ConformanceSubject>,
  options: ConformanceOptions = {},
): void {
  const replay = options.replay ?? true;
  describe(`CommerceProvider conformance: ${name}`, () => {
    let provider: CommerceProvider;
    let f: ConformanceFixtures;

    beforeEach(async () => {
      ({ provider, fixtures: f } = await setup());
    });

    function needs(ctx: TestContext, ...capabilities: Capability[]): void {
      if (!capabilities.every((capability) => provider.capabilities.has(capability))) ctx.skip();
    }

    function needsReplay(ctx: TestContext): void {
      if (!replay) ctx.skip();
    }

    function needsControl(ctx: TestContext): ConformanceControl {
      if (!f.control) ctx.skip();
      if (!f.control) throw new Error("unreachable: skipped");
      return f.control;
    }

    /** Runs `body` with a variant's stock changed, then restores it even if `body` fails. */
    async function withStock(
      control: ConformanceControl,
      variantId: string,
      quantity: number,
      restoreTo: number,
      body: () => Promise<void>,
    ): Promise<void> {
      await control.setStock(variantId, quantity);
      try {
        await body();
      } finally {
        await control.setStock(variantId, restoreTo);
      }
    }

    async function addOne(cart: Cart, variantId = f.inStockVariantId, quantity = 1): Promise<Cart> {
      return provider.addCartLines(cart.id, { lines: [{ variantId, quantity }] }, writeKey());
    }

    async function newCart(): Promise<Cart> {
      return provider.createCart({ attributes: { [ATTRIBUTION_ATTRIBUTE]: "conv_conformance" } }, writeKey());
    }

    it("declares a lowercase platform id and at least one capability", () => {
      expect(provider.platform).toMatch(/^[a-z0-9-]+$/);
      expect(provider.capabilities.size).toBeGreaterThan(0);
    });

    it("methods for undeclared capabilities throw NOT_SUPPORTED", async (ctx) => {
      const probes: Record<Capability, () => Promise<unknown>> = {
        "catalog.search": () => provider.searchProducts({ query: f.searchTerm }),
        "catalog.read": () => provider.getProduct(f.productId),
        "catalog.list": () => provider.listProducts({}),
        "inventory.read": () => provider.getInventory([f.inStockVariantId]),
        "cart.write": () => provider.createCart({}, writeKey()),
        "checkout.handoff": () => provider.createCheckout("conformance-cart", writeKey()),
        "orders.lookup": () => provider.lookupOrder({ orderNumber: f.orderNumber, identity: f.orderOwner }),
      };
      const undeclared = CAPABILITIES.filter((capability) => !provider.capabilities.has(capability));
      if (undeclared.length === 0) ctx.skip();
      for (const capability of undeclared) {
        await expectCommerceError(probes[capability](), "NOT_SUPPORTED");
      }
    });

    // fixtures ------------------------------------------------------------

    it("fixtures describe the store correctly", async (ctx) => {
      needs(ctx, "inventory.read");
      expect(f.inStockQuantity).toBeGreaterThanOrEqual(2);
      expect(f.inStockQuantity).toBeLessThan(MAX_LINE_QUANTITY);
      const levels = await provider.getInventory([f.inStockVariantId, f.outOfStockVariantId]);
      const byId = new Map(levels.map((level) => [level.variantId, level]));
      const inStock = byId.get(f.inStockVariantId)?.quantityAvailable;
      if (inStock !== null) expect(inStock).toBe(f.inStockQuantity);
      expect(byId.get(f.outOfStockVariantId)?.quantityAvailable ?? 0).toBe(0);
      if (provider.capabilities.has("catalog.read")) {
        expect(await provider.getProduct(f.productId)).not.toBeNull();
      }
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

    it("listProducts treats updatedSince as inclusive", async (ctx) => {
      needs(ctx, "catalog.list");
      const [first] = (await provider.listProducts({ limit: 1 })).items;
      if (!first) throw new Error("expected at least one product");
      const seen: string[] = [];
      let cursor: string | undefined;
      for (let page = 0; page < 20; page += 1) {
        const result = await provider.listProducts({ updatedSince: first.updatedAt, limit: 250, cursor });
        seen.push(...result.items.map((item) => item.id));
        if (result.nextCursor === null || seen.includes(first.id)) break;
        cursor = result.nextCursor;
      }
      expect(seen).toContain(first.id);
    });

    it("reports every datetime in UTC with Z", async (ctx) => {
      needs(ctx, "catalog.read");
      expect((await provider.getProduct(f.productId))?.updatedAt).toMatch(UTC_DATETIME);
      if (provider.capabilities.has("cart.write")) expect((await newCart()).updatedAt).toMatch(UTC_DATETIME);
      if (provider.capabilities.has("orders.lookup")) {
        const order = await provider.lookupOrder({ orderNumber: f.orderNumber, identity: f.orderOwner });
        expect(order?.placedAt).toMatch(UTC_DATETIME);
      }
    });

    it("getInventory omits unknown variant ids", async (ctx) => {
      needs(ctx, "inventory.read");
      const levels = await provider.getInventory([f.inStockVariantId, "no-such-variant-000"]);
      expect(levels.map((level) => level.variantId)).toEqual([f.inStockVariantId]);
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
      needsReplay(ctx);
      const cart = await newCart();
      const opts = writeKey();
      const input = { lines: [{ variantId: f.inStockVariantId, quantity: 1 }] };
      const first = await provider.addCartLines(cart.id, input, opts);
      const replay = await provider.addCartLines(cart.id, input, opts);
      expect(replay.itemCount).toBe(1);
      expect(replay).toEqual(first);
    });

    it("replaying createCart returns the same cart", async (ctx) => {
      needs(ctx, "cart.write");
      needsReplay(ctx);
      const opts = writeKey();
      const first = await provider.createCart({}, opts);
      expect(await provider.createCart({}, opts)).toEqual(first);
    });

    it("replaying updateCartLine returns the first result, even after the cart changed", async (ctx) => {
      needs(ctx, "cart.write");
      needsReplay(ctx);
      const cart = await newCart();
      const lineId = onlyLine(await addOne(cart)).id;
      const opts = writeKey();
      const first = await provider.updateCartLine(cart.id, { lineId, quantity: 2 }, opts);
      await provider.updateCartLine(cart.id, { lineId, quantity: 1 }, writeKey());
      expect(await provider.updateCartLine(cart.id, { lineId, quantity: 2 }, opts)).toEqual(first);
      expect(onlyLine((await provider.getCart(cart.id)) ?? first).quantity).toBe(1);
    });

    it("replaying createCheckout returns the same handoff", async (ctx) => {
      needs(ctx, "cart.write", "checkout.handoff");
      needsReplay(ctx);
      const cart = await newCart();
      await addOne(cart);
      const opts = writeKey();
      const first = await provider.createCheckout(cart.id, opts);
      expect(await provider.createCheckout(cart.id, opts)).toEqual(first);
    });

    it("a failed write does not hold its idempotency key", async (ctx) => {
      needs(ctx, "cart.write");
      const cart = await newCart();
      const opts = writeKey();
      await expectCommerceError(
        provider.addCartLines(cart.id, { lines: [{ variantId: f.outOfStockVariantId, quantity: 1 }] }, opts),
        "OUT_OF_STOCK",
      );
      const retried = await provider.addCartLines(
        cart.id,
        { lines: [{ variantId: f.inStockVariantId, quantity: 1 }] },
        opts,
      );
      expect(onlyLine(retried).variantId).toBe(f.inStockVariantId);
    });

    it("retrying a failed write with the same key succeeds once the cause is gone", async (ctx) => {
      needs(ctx, "cart.write");
      const control = needsControl(ctx);
      const cart = await newCart();
      const opts = writeKey();
      const input = { lines: [{ variantId: f.outOfStockVariantId, quantity: 1 }] };
      await expectCommerceError(provider.addCartLines(cart.id, input, opts), "OUT_OF_STOCK");
      await withStock(control, f.outOfStockVariantId, 3, 0, async () => {
        expect(onlyLine(await provider.addCartLines(cart.id, input, opts)).quantity).toBe(1);
      });
    });

    it("rejects quantities above the available stock and leaves the cart unchanged", async (ctx) => {
      needs(ctx, "cart.write");
      const cart = await newCart();
      await expectCommerceError(addOne(cart, f.inStockVariantId, f.inStockQuantity + 1), "OUT_OF_STOCK");
      expect((await provider.getCart(cart.id))?.lines).toHaveLength(0);
      const line = onlyLine(await addOne(cart, f.inStockVariantId, 1));
      await expectCommerceError(
        provider.updateCartLine(cart.id, { lineId: line.id, quantity: f.inStockQuantity + 1 }, writeKey()),
        "OUT_OF_STOCK",
      );
      await expectCommerceError(addOne(cart, f.inStockVariantId, f.inStockQuantity), "OUT_OF_STOCK");
      expect(onlyLine((await provider.getCart(cart.id)) ?? cart).quantity).toBe(1);
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

    it("is atomic: a multi-line add with one failing line changes nothing", async (ctx) => {
      needs(ctx, "cart.write");
      const cart = await newCart();
      await expectCommerceError(
        provider.addCartLines(
          cart.id,
          {
            lines: [
              { variantId: f.inStockVariantId, quantity: 1 },
              { variantId: f.outOfStockVariantId, quantity: 1 },
            ],
          },
          writeKey(),
        ),
        "OUT_OF_STOCK",
      );
      expect((await provider.getCart(cart.id))?.lines).toHaveLength(0);
    });

    it("is atomic when the cart already holds one of the variants", async (ctx) => {
      needs(ctx, "cart.write");
      const cart = await newCart();
      const before = await addOne(cart);
      await expectCommerceError(
        provider.addCartLines(
          cart.id,
          {
            lines: [
              { variantId: f.inStockVariantId, quantity: 1 },
              { variantId: f.outOfStockVariantId, quantity: 1 },
            ],
          },
          writeKey(),
        ),
        "OUT_OF_STOCK",
      );
      const after = await provider.getCart(cart.id);
      expect(after?.lines.map((line) => [line.variantId, line.quantity])).toEqual([[f.inStockVariantId, 1]]);
      expect(after?.subtotal).toEqual(before.subtotal);
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

    it("updateCartAttributes merges attributes into an existing cart", async (ctx) => {
      needs(ctx, "cart.write");
      const cart = await provider.createCart({}, writeKey());
      const tagged = await provider.updateCartAttributes(
        cart.id,
        { attributes: { [ATTRIBUTION_ATTRIBUTE]: "conv_existing" } },
        writeKey(),
      );
      expect(tagged.attributes[ATTRIBUTION_ATTRIBUTE]).toBe("conv_existing");
      const merged = await provider.updateCartAttributes(
        cart.id,
        { attributes: { channel: "web" } },
        writeKey(),
      );
      expect(merged.attributes).toMatchObject({ [ATTRIBUTION_ATTRIBUTE]: "conv_existing", channel: "web" });
      const overwritten = await provider.updateCartAttributes(
        cart.id,
        { attributes: { [ATTRIBUTION_ATTRIBUTE]: "conv_new" } },
        writeKey(),
      );
      expect(overwritten.attributes).toMatchObject({ [ATTRIBUTION_ATTRIBUTE]: "conv_new", channel: "web" });
      await expectCommerceError(
        provider.updateCartAttributes("no-such-cart", { attributes: { channel: "web" } }, writeKey()),
        "NOT_FOUND",
      );
      await expectCommerceError(
        provider.updateCartAttributes(cart.id, { attributes: {} }, writeKey()),
        "INVALID_INPUT",
      );
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
      if (handoff.expiresAt !== null) expect(handoff.expiresAt).toMatch(UTC_DATETIME);
    });

    it("createCheckout returns OUT_OF_STOCK when a line can no longer be fulfilled", async (ctx) => {
      needs(ctx, "cart.write", "checkout.handoff");
      const control = needsControl(ctx);
      const cart = await newCart();
      await addOne(cart, f.inStockVariantId, 2);
      await withStock(control, f.inStockVariantId, 1, f.inStockQuantity, async () => {
        await expectCommerceError(provider.createCheckout(cart.id, writeKey()), "OUT_OF_STOCK");
      });
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
      for (const order of mine) expect(() => OrderSchema.parse(order)).not.toThrow();
      const placed = mine.map((order) => Date.parse(order.placedAt));
      expect(placed).toEqual([...placed].sort((a, b) => b - a));
      expect(await provider.listOrders({ identity: f.stranger })).toEqual([]);
    });
  });
}
