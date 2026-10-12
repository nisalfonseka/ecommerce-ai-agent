import { type NextRequest, NextResponse } from "next/server";
import { CART_COOKIE, CART_COOKIE_MAX_AGE } from "@/lib/cart-cookie";
import { getCart } from "@/lib/medusa";

/**
 * The assistant's checkout handoff (@ace/adapter-medusa createCheckout): makes the chat's cart this browser's
 * cart, then opens checkout. Only open carts are adopted; the cart id itself is the bearer secret.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const cartId = request.nextUrl.searchParams.get("cart_id") ?? "";
  const cart = /^[A-Za-z0-9_]{1,100}$/.test(cartId) ? await getCart(cartId) : null;
  if (!cart || cart.completed_at) return NextResponse.redirect(new URL("/cart", request.url));
  const response = NextResponse.redirect(new URL("/checkout", request.url));
  response.cookies.set(CART_COOKIE, cart.id, { path: "/", sameSite: "lax", maxAge: CART_COOKIE_MAX_AGE });
  return response;
}
