import { MemoryCommerceProvider } from "@ace/adapter-memory";
import { type AddCartLinesInput, type Cart, CommerceError, type WriteOptions } from "@ace/contracts";
import { describe, expect, it } from "vitest";
import { createMemoryIdempotencyStore, IdempotentCommerceProvider } from "./idempotent-provider";

const key = (k: string): WriteOptions => ({ idempotencyKey: `test-key-${k}` });
const kurtaM = { lines: [{ variantId: "p_kurta_navy_m", quantity: 1 }] };

/** Counts inner calls and can fail a chosen call before or after applying it. */
class FlakyProvider extends MemoryCommerceProvider {
  addCalls = 0;
  failNext: "before" | "after" | "after-translated" | null = null;

  override async addCartLines(cartId: string, input: AddCartLinesInput, opts: WriteOptions): Promise<Cart> {
    this.addCalls += 1;
    const mode = this.failNext;
    this.failNext = null;
    if (mode === "before") throw new Error("ETIMEDOUT");
    // A fresh key inside, so the memory adapter's own replay map does not hide a second apply.
    const cart = await super.addCartLines(cartId, input, {
      idempotencyKey: `inner-${this.addCalls}-${opts.idempotencyKey}`,
    });
    if (mode === "after") throw new Error("socket hang up");
    if (mode === "after-translated") throw new CommerceError("UPSTREAM_UNAVAILABLE", "timed out");
    return cart;
  }
}

function setup() {
  const inner = new FlakyProvider();
  const provider = new IdempotentCommerceProvider(inner, createMemoryIdempotencyStore(), { storeId: "s1" });
  return { inner, provider };
}

describe("IdempotentCommerceProvider", () => {
  it("replays a write with the same key and input without calling the store again", async () => {
    const { inner, provider } = setup();
    const cart = await provider.createCart({}, key("cart"));
    const first = await provider.addCartLines(cart.id, kurtaM, key("add"));
    const again = await provider.addCartLines(cart.id, kurtaM, key("add"));
    expect(again).toEqual(first);
    expect(inner.addCalls).toBe(1);
    expect((await provider.getCart(cart.id))?.itemCount).toBe(1);
  });

  it("rejects the same key with a different input as CONFLICT", async () => {
    const { provider } = setup();
    const cart = await provider.createCart({}, key("cart"));
    await provider.addCartLines(cart.id, kurtaM, key("add"));
    await expect(
      provider.addCartLines(cart.id, { lines: [{ variantId: "p_kurta_navy_l", quantity: 1 }] }, key("add")),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("forgets a write that failed with a CommerceError, so the same key may run again", async () => {
    const { inner, provider } = setup();
    const cart = await provider.createCart({}, key("cart"));
    const soldOut = { lines: [{ variantId: "p_linen_shirt_black_l", quantity: 1 }] };
    await expect(provider.addCartLines(cart.id, soldOut, key("add"))).rejects.toBeInstanceOf(CommerceError);
    await expect(provider.addCartLines(cart.id, soldOut, key("add"))).rejects.toMatchObject({
      code: "OUT_OF_STOCK",
    });
    expect(inner.addCalls).toBe(2);
  });

  it("does not add twice when a timeout hid a write that was applied", async () => {
    const { inner, provider } = setup();
    const cart = await provider.createCart({}, key("cart"));
    inner.failNext = "after";
    await expect(provider.addCartLines(cart.id, kurtaM, key("add"))).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      retryable: true,
    });
    const replay = await provider.addCartLines(cart.id, kurtaM, key("add"));
    expect(replay.itemCount).toBe(1);
    expect(inner.addCalls).toBe(1);
  });

  it("applies once when a timeout happened before the write reached the store", async () => {
    const { inner, provider } = setup();
    const cart = await provider.createCart({}, key("cart"));
    inner.failNext = "before";
    await expect(provider.addCartLines(cart.id, kurtaM, key("add"))).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
    const replay = await provider.addCartLines(cart.id, kurtaM, key("add"));
    expect(replay.itemCount).toBe(1);
    expect(inner.addCalls).toBe(2);
    expect((await provider.addCartLines(cart.id, kurtaM, key("add"))).itemCount).toBe(1);
  });

  it("treats an adapter's UPSTREAM_UNAVAILABLE on a write as ambiguous (a timeout may hide an applied write)", async () => {
    const { inner, provider } = setup();
    const cart = await provider.createCart({}, key("cart"));
    inner.failNext = "after-translated";
    await expect(provider.addCartLines(cart.id, kurtaM, key("add"))).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
    const replay = await provider.addCartLines(cart.id, kurtaM, key("add"));
    expect(replay.itemCount).toBe(1);
    expect(inner.addCalls).toBe(1);
  });

  it("places a COD order once per key and passes quotes through", async () => {
    const { provider } = setup();
    const cart = await provider.createCart({}, key("cart"));
    await provider.addCartLines(cart.id, kurtaM, key("add"));
    const details = {
      name: "Nimali",
      phone: "0771234567",
      address: { line1: "12 Galle Road", city: "Colombo", countryCode: "LK" },
    };
    expect((await provider.quoteCodOrder(cart.id, details)).itemCount).toBe(1);
    const order = await provider.placeCodOrder(cart.id, details, key("cod"));
    expect(await provider.placeCodOrder(cart.id, details, key("cod"))).toEqual(order);
    await expect(provider.placeCodOrder(cart.id, details, key("cod-2"))).rejects.toMatchObject({
      code: "CONFLICT",
    });
  });

  it("passes reads and capabilities through", async () => {
    const { inner, provider } = setup();
    expect(provider.platform).toBe("memory");
    expect(provider.capabilities).toBe(inner.capabilities);
    expect((await provider.getProduct("p_kurta_navy"))?.title).toBe("Navy Cotton Kurta");
  });
});
