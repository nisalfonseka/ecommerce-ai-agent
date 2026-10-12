import { CommerceError } from "@ace/contracts";
import { describe, expect, it } from "vitest";
import { MedusaCommerceProvider } from "./medusa-provider";

interface Item {
  id: string;
  variant_id: string;
  quantity: number;
}

/**
 * A tiny fake of the Medusa endpoints addCartLines uses. `failAdd` makes the nth line-item POST fail: "race"
 * answers insufficient_inventory without applying; "timeout" applies the change and then drops the response.
 */
function fakeMedusa(failAdd?: { call: number; mode: "race" | "timeout" }) {
  const items: Item[] = [{ id: "line_a", variant_id: "var_a", quantity: 1 }];
  let addCalls = 0;
  let nextLine = 1;
  const cart = () => ({
    id: "cart_1",
    currency_code: "lkr",
    metadata: {},
    updated_at: "2026-10-09T00:00:00.000Z",
    completed_at: null,
    items: items.map((item) => ({ ...item, product_id: "prod_1", title: "Shirt", unit_price: 1000 })),
  });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const path = url.pathname;
    if (path === "/store/regions/reg_1") {
      return json(200, { region: { id: "reg_1", currency_code: "lkr", countries: [{ iso_2: "lk" }] } });
    }
    if (path === "/store/product-variants") {
      const ids = url.searchParams.getAll("id[]");
      return json(200, {
        variants: ids.map((id) => ({
          id,
          manage_inventory: true,
          allow_backorder: false,
          inventory_quantity: 5,
        })),
      });
    }
    if (path === "/store/carts/cart_1" && method === "GET") return json(200, { cart: cart() });
    if (path === "/store/carts/cart_1/line-items" && method === "POST") {
      addCalls += 1;
      if (failAdd?.call === addCalls && failAdd.mode === "race") {
        return json(400, { code: "insufficient_inventory", type: "not_allowed", message: "…" });
      }
      items.push({ id: `line_new_${nextLine++}`, variant_id: body.variant_id, quantity: body.quantity });
      if (failAdd?.call === addCalls) throw new DOMException("timed out", "TimeoutError");
      return json(200, { cart: cart() });
    }
    const lineMatch = /^\/store\/carts\/cart_1\/line-items\/(.+)$/.exec(path);
    if (lineMatch) {
      const index = items.findIndex((item) => item.id === lineMatch[1]);
      const item = items[index];
      if (!item) return json(404, { type: "not_found" });
      if (method === "DELETE") items.splice(index, 1);
      else item.quantity = body.quantity;
      return json(200, method === "DELETE" ? { parent: cart() } : { cart: cart() });
    }
    return json(404, { type: "not_found", message: `no fake for ${method} ${path}` });
  };
  const provider = new MedusaCommerceProvider({
    baseUrl: "https://medusa.test",
    publishableKey: "pk",
    secretKey: "sk",
    regionId: "reg_1",
    storefrontUrl: "https://shop.test",
    fetch,
  });
  return { provider, items };
}

const add = {
  lines: [
    { variantId: "var_a", quantity: 1 },
    { variantId: "var_b", quantity: 2 },
    { variantId: "var_c", quantity: 1 },
  ],
};
const key = { idempotencyKey: "test-key-0001" };
const snapshot = (items: Item[]) => items.map((item) => [item.variant_id, item.quantity]);

describe("MedusaCommerceProvider.addCartLines atomicity", () => {
  it("applies every line when nothing fails", async () => {
    const { provider, items } = fakeMedusa();
    const cart = await provider.addCartLines("cart_1", add, key);
    expect(cart.itemCount).toBe(5);
    expect(snapshot(items)).toEqual([
      ["var_a", 2],
      ["var_b", 2],
      ["var_c", 1],
    ]);
  });

  it("restores earlier lines when a later line loses a stock race", async () => {
    const { provider, items } = fakeMedusa({ call: 2, mode: "race" });
    await expect(provider.addCartLines("cart_1", add, key)).rejects.toMatchObject({ code: "OUT_OF_STOCK" });
    expect(snapshot(items)).toEqual([["var_a", 1]]);
  });

  it("also undoes a write whose response timed out, and reports the failure as retryable", async () => {
    const { provider, items } = fakeMedusa({ call: 1, mode: "timeout" });
    const error = await provider.addCartLines("cart_1", add, key).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CommerceError);
    expect(error).toMatchObject({ code: "UPSTREAM_UNAVAILABLE", retryable: true });
    expect(snapshot(items)).toEqual([["var_a", 1]]);
  });
});
