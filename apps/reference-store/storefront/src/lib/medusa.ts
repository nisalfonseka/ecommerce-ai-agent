import "server-only";

/** Server-side Store API client. The publishable key is public by design, but keeping calls on the server keeps
 * the storefront simple and lets server actions own the cart cookie. */
const BACKEND = process.env.MEDUSA_BACKEND_URL ?? "http://localhost:9000";
const KEY = process.env.MEDUSA_PUBLISHABLE_KEY ?? "";
export const REGION_ID = process.env.MEDUSA_REGION_ID ?? "";

export class MedusaError extends Error {
  constructor(
    readonly status: number,
    readonly body: { type?: string; code?: string; message?: string } | null,
  ) {
    super(`Medusa ${status}: ${body?.message ?? "request failed"}`);
  }
}

export async function store<T>(
  path: string,
  init: { method?: string; body?: unknown; query?: Record<string, string> } = {},
): Promise<T> {
  const url = new URL(path, BACKEND);
  for (const [name, value] of Object.entries(init.query ?? {})) url.searchParams.set(name, value);
  const response = await fetch(url, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", "x-publishable-api-key": KEY },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new MedusaError(response.status, body);
  return body as T;
}

export interface Variant {
  id: string;
  title: string;
  inventory_quantity?: number | null;
  manage_inventory?: boolean | null;
  calculated_price?: { calculated_amount: number; currency_code: string } | null;
}
export interface Product {
  id: string;
  handle: string;
  title: string;
  description: string | null;
  thumbnail: string | null;
  variants: Variant[];
}
export interface LineItem {
  id: string;
  title: string;
  product_title?: string | null;
  variant_title?: string | null;
  quantity: number;
  unit_price: number;
  thumbnail?: string | null;
}
export interface Cart {
  id: string;
  currency_code: string;
  completed_at: string | null;
  items: LineItem[];
  item_subtotal?: number;
  shipping_total?: number;
  total?: number;
  email?: string | null;
}

const PRODUCT_FIELDS =
  "id,handle,title,description,thumbnail,*variants,*variants.calculated_price,+variants.inventory_quantity";
const CART_FIELDS = "id,currency_code,completed_at,email,item_subtotal,shipping_total,total,*items";

export async function listProducts(): Promise<Product[]> {
  const { products } = await store<{ products: Product[] }>("/store/products", {
    query: { region_id: REGION_ID, fields: PRODUCT_FIELDS, limit: "50" },
  });
  return products;
}

export async function getProductByHandle(handle: string): Promise<Product | null> {
  const { products } = await store<{ products: Product[] }>("/store/products", {
    query: { region_id: REGION_ID, fields: PRODUCT_FIELDS, handle },
  });
  return products[0] ?? null;
}

export async function getCart(cartId: string): Promise<Cart | null> {
  try {
    const { cart } = await store<{ cart: Cart }>(`/store/carts/${encodeURIComponent(cartId)}`, {
      query: { fields: CART_FIELDS },
    });
    return cart;
  } catch (error) {
    if (error instanceof MedusaError && error.status === 404) return null;
    throw error;
  }
}

export function cartFields() {
  return { fields: CART_FIELDS };
}

/** Medusa v2 amounts are major units. */
export function formatPrice(amount: number | undefined, currency: string): string {
  return new Intl.NumberFormat("en-LK", { style: "currency", currency: currency.toUpperCase() }).format(
    amount ?? 0,
  );
}
