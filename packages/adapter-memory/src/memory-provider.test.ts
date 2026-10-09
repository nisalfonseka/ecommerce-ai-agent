import type { VerifiedIdentity } from "@ace/contracts";
import { CAPABILITIES } from "@ace/contracts";
import { describe, expect, it } from "vitest";
import { availabilityFor, MemoryCommerceProvider } from "./memory-provider";
import { defaultSeed } from "./seed";

const verifiedAt = "2026-10-01T00:00:00.000Z";
const byEmail = (email: string): VerifiedIdentity => ({ method: "email_otp", email, verifiedAt });

describe("availabilityFor", () => {
  it("derives availability from units in stock", () => {
    expect(availabilityFor(0)).toBe("out_of_stock");
    expect(availabilityFor(1)).toBe("low_stock");
    expect(availabilityFor(2)).toBe("low_stock");
    expect(availabilityFor(3)).toBe("in_stock");
  });
});

describe("MemoryCommerceProvider — catalog and inventory", () => {
  it("returns products with availability derived from stock", async () => {
    const provider = new MemoryCommerceProvider();
    const shirt = await provider.getProduct("p_linen_shirt_black");
    const availability = Object.fromEntries(
      shirt?.variants.map((v) => [v.title, v.availability] as const) ?? [],
    );
    expect(availability).toEqual({
      "Black / S": "in_stock",
      "Black / M": "in_stock",
      "Black / L": "out_of_stock",
    });
  });

  it("search with inStockOnly + size L skips the sold-out linen shirt but keeps the low-stock dress", async () => {
    const provider = new MemoryCommerceProvider();
    const result = await provider.searchProducts({
      query: "black",
      filters: { options: { size: ["L"] }, inStockOnly: true },
    });
    expect(result.items.map((item) => item.id)).toEqual(["p_wrap_dress_black"]);
  });

  it("getInventory omits unknown variant ids", async () => {
    const provider = new MemoryCommerceProvider();
    const levels = await provider.getInventory(["p_wrap_dress_black_l", "nope"]);
    expect(levels).toEqual([
      { variantId: "p_wrap_dress_black_l", availability: "low_stock", quantityAvailable: 1 },
    ]);
  });

  it("search summary describes only the matching variants", async () => {
    const provider = new MemoryCommerceProvider();
    const result = await provider.searchProducts({
      query: "linen",
      filters: { options: { size: ["L"] } },
    });
    const shirt = result.items.find((item) => item.id === "p_linen_shirt_black");
    expect(shirt).toMatchObject({
      availability: "out_of_stock",
      matchingVariantIds: ["p_linen_shirt_black_l"],
    });
  });

  it("getInventory deduplicates repeated ids, keeping first-occurrence order", async () => {
    const provider = new MemoryCommerceProvider();
    const levels = await provider.getInventory(["p_kurta_navy_m", "p_kurta_navy_m"]);
    expect(levels.map((level) => level.variantId)).toEqual(["p_kurta_navy_m"]);
    const mixed = await provider.getInventory([
      "p_wrap_dress_black_l",
      "p_kurta_navy_m",
      "p_wrap_dress_black_l",
    ]);
    expect(mixed.map((level) => level.variantId)).toEqual(["p_wrap_dress_black_l", "p_kurta_navy_m"]);
  });

  it("getInventory rejects an empty id list", async () => {
    const provider = new MemoryCommerceProvider();
    await expect(provider.getInventory([])).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });

  it("listProducts pages in stable id order and honours updatedSince", async () => {
    const provider = new MemoryCommerceProvider();
    const first = await provider.listProducts({ limit: 4 });
    const second = await provider.listProducts({ limit: 4, cursor: first.nextCursor ?? undefined });
    const all = [...first.items, ...second.items].map((p) => p.id);
    expect(all).toEqual([...all].sort());
    expect(all).toHaveLength(6);
    expect(second.nextCursor).toBeNull();
    expect((await provider.listProducts({ updatedSince: "2030-01-01T00:00:00.000Z" })).items).toEqual([]);
  });

  it("declares every capability", () => {
    const provider = new MemoryCommerceProvider();
    expect([...provider.capabilities].sort()).toEqual([...CAPABILITIES].sort());
  });
});

describe("MemoryCommerceProvider — orders", () => {
  it("finds an order for its owner regardless of order-number case", async () => {
    const provider = new MemoryCommerceProvider();
    const order = await provider.lookupOrder({
      orderNumber: "ace-1001",
      identity: byEmail("customer@example.com"),
    });
    expect(order?.number).toBe("ACE-1001");
  });

  it("finds an order by the owner's phone", async () => {
    const provider = new MemoryCommerceProvider();
    const identity: VerifiedIdentity = { method: "phone_otp", phone: "+94771234567", verifiedAt };
    expect((await provider.lookupOrder({ orderNumber: "ACE-1001", identity }))?.id).toBe("ord_1001");
  });

  it("returns null to a stranger, exactly as for a missing order", async () => {
    const provider = new MemoryCommerceProvider();
    const stranger = byEmail("someone-else@example.com");
    expect(await provider.lookupOrder({ orderNumber: "ACE-1001", identity: stranger })).toBeNull();
    expect(await provider.lookupOrder({ orderNumber: "ACE-9999", identity: stranger })).toBeNull();
  });

  it("returns copies, so callers cannot mutate stored orders", async () => {
    const provider = new MemoryCommerceProvider();
    const identity = byEmail("customer@example.com");
    const order = await provider.lookupOrder({ orderNumber: "ACE-1001", identity });
    if (order) order.status = "cancelled";
    expect((await provider.lookupOrder({ orderNumber: "ACE-1001", identity }))?.status).toBe("shipped");
  });
});

describe("MemoryCommerceProvider — carts", () => {
  let counter = 0;
  const key = () => ({ idempotencyKey: `test-key-${++counter}` });
  const add = (variantId: string, quantity: number) => ({ lines: [{ variantId, quantity }] });

  it("tags an existing cart without touching its lines", async () => {
    const provider = new MemoryCommerceProvider();
    const cart = await provider.createCart({}, key());
    await provider.addCartLines(cart.id, add("p_kurta_navy_m", 1), key());
    const tagged = await provider.updateCartAttributes(
      cart.id,
      { attributes: { ace_conversation_id: "c1" } },
      key(),
    );
    expect(tagged.itemCount).toBe(1);
    expect(tagged.attributes).toEqual({ ace_conversation_id: "c1" });
  });

  it("refuses to create a cart in a currency the store does not sell", async () => {
    const provider = new MemoryCommerceProvider();
    await expect(provider.createCart({ currency: "USD" }, key())).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("refuses more units than are in stock and reports what is available", async () => {
    const provider = new MemoryCommerceProvider();
    const cart = await provider.createCart({}, key());
    await expect(provider.addCartLines(cart.id, add("p_wrap_dress_black_m", 5), key())).rejects.toMatchObject(
      {
        code: "OUT_OF_STOCK",
        details: { variantId: "p_wrap_dress_black_m", available: 4 },
      },
    );
    expect((await provider.getCart(cart.id))?.lines).toEqual([]);
  });

  it("is atomic: one failing line in a multi-line add changes nothing", async () => {
    const provider = new MemoryCommerceProvider();
    const cart = await provider.createCart({}, key());
    const input = {
      lines: [
        { variantId: "p_kurta_navy_m", quantity: 1 },
        { variantId: "p_linen_shirt_black_l", quantity: 1 },
      ],
    };
    await expect(provider.addCartLines(cart.id, input, key())).rejects.toMatchObject({
      code: "OUT_OF_STOCK",
    });
    expect((await provider.getCart(cart.id))?.itemCount).toBe(0);
  });

  it("rejects merges that would exceed the per-line maximum", async () => {
    const seed = defaultSeed();
    seed.stock.p_oxford_shirt_white_m = 50;
    const provider = new MemoryCommerceProvider({ seed });
    const cart = await provider.createCart({}, key());
    await provider.addCartLines(cart.id, add("p_oxford_shirt_white_m", 20), key());
    await expect(
      provider.addCartLines(cart.id, add("p_oxford_shirt_white_m", 1), key()),
    ).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  it("rejects an update to more units than are in stock", async () => {
    const provider = new MemoryCommerceProvider();
    const cart = await provider.createCart({}, key());
    const added = await provider.addCartLines(cart.id, add("p_wrap_dress_black_l", 1), key());
    const lineId = added.lines[0]?.id ?? "";
    await expect(provider.updateCartLine(cart.id, { lineId, quantity: 2 }, key())).rejects.toMatchObject({
      code: "OUT_OF_STOCK",
    });
  });

  it("scopes idempotency keys to the cart", async () => {
    const provider = new MemoryCommerceProvider();
    const a = await provider.createCart({}, key());
    const b = await provider.createCart({}, key());
    const shared = key();
    await provider.addCartLines(a.id, add("p_kurta_navy_m", 1), shared);
    const resultB = await provider.addCartLines(b.id, add("p_kurta_navy_m", 1), shared);
    expect(resultB.id).toBe(b.id);
    expect(resultB.itemCount).toBe(1);
  });

  it("can leave replay to the engine (idempotency: false)", async () => {
    const provider = new MemoryCommerceProvider({ idempotency: false });
    const cart = await provider.createCart({}, key());
    const same = key();
    await provider.addCartLines(cart.id, add("p_kurta_navy_m", 1), same);
    expect((await provider.addCartLines(cart.id, add("p_kurta_navy_m", 1), same)).itemCount).toBe(2);
  });

  it("setStock changes live availability (test hook)", async () => {
    const provider = new MemoryCommerceProvider();
    provider.setStock("p_linen_shirt_black_l", 5);
    expect(await provider.getInventory(["p_linen_shirt_black_l"])).toEqual([
      { variantId: "p_linen_shirt_black_l", availability: "in_stock", quantityAvailable: 5 },
    ]);
    expect(() => provider.setStock("nope", 1)).toThrow();
  });

  it("keeps carts separate between provider instances", async () => {
    const first = new MemoryCommerceProvider();
    const second = new MemoryCommerceProvider();
    const cart = await first.createCart({}, key());
    expect(await second.getCart(cart.id)).toBeNull();
  });

  it("builds the checkout URL from the configured base", async () => {
    const provider = new MemoryCommerceProvider({ checkoutBaseUrl: "https://shop.test/pay" });
    const cart = await provider.createCart({}, key());
    await provider.addCartLines(cart.id, add("p_kurta_navy_m", 1), key());
    const handoff = await provider.createCheckout(cart.id, key());
    expect(handoff).toEqual({ cartId: cart.id, url: `https://shop.test/pay/${cart.id}`, expiresAt: null });
  });

  it("does not leak seed images through returned carts", async () => {
    const provider = new MemoryCommerceProvider();
    const cart = await provider.createCart({}, key());
    const returned = await provider.addCartLines(cart.id, add("p_kurta_navy_m", 1), key());
    const image = returned.lines[0]?.image;
    if (image) image.url = "https://evil.test/mutated.jpg";
    const expected = "https://demo-store.test/images/kurta-navy.jpg";
    expect(image).toBeDefined();
    expect((await provider.getCart(cart.id))?.lines[0]?.image?.url).toBe(expected);
    expect((await provider.getProduct("p_kurta_navy"))?.images[0]?.url).toBe(expected);
  });

  it("uses the injected clock for updatedAt", async () => {
    const provider = new MemoryCommerceProvider({ now: () => new Date("2026-10-08T12:00:00.000Z") });
    const cart = await provider.createCart({}, key());
    expect(cart.updatedAt).toBe("2026-10-08T12:00:00.000Z");
  });
});
