import type { VerifiedIdentity } from "@ace/contracts";
import { CommerceError } from "@ace/contracts";
import { describe, expect, it } from "vitest";
import { availabilityFor, MemoryCommerceProvider } from "./memory-provider";

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

  it("does not declare cart capabilities yet", async () => {
    const provider = new MemoryCommerceProvider();
    expect(provider.capabilities.has("cart.write")).toBe(false);
    await expect(provider.getCart("x")).rejects.toBeInstanceOf(CommerceError);
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
