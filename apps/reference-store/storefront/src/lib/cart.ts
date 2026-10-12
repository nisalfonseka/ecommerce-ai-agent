import "server-only";
import { cookies } from "next/headers";
import { CART_COOKIE, CART_COOKIE_MAX_AGE } from "./cart-cookie";
import { type Cart, cartFields, getCart, REGION_ID, store } from "./medusa";

export async function currentCart(): Promise<Cart | null> {
  const id = (await cookies()).get(CART_COOKIE)?.value;
  if (!id) return null;
  const cart = await getCart(id);
  return cart && !cart.completed_at ? cart : null;
}

export async function setCartCookie(cartId: string | null): Promise<void> {
  const jar = await cookies();
  if (cartId === null) jar.delete(CART_COOKIE);
  else jar.set(CART_COOKIE, cartId, { path: "/", sameSite: "lax", maxAge: CART_COOKIE_MAX_AGE });
}

/** The open cart, or a new one in the store's region. */
export async function ensureCart(): Promise<Cart> {
  const existing = await currentCart();
  if (existing) return existing;
  const { cart } = await store<{ cart: Cart }>("/store/carts", {
    method: "POST",
    body: { region_id: REGION_ID },
    query: cartFields(),
  });
  await setCartCookie(cart.id);
  return cart;
}
