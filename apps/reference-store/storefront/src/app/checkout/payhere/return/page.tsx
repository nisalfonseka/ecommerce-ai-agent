import { currentCart } from "@/lib/cart";
import { WaitForOrder } from "./wait-for-order";

export const dynamic = "force-dynamic";

/** PayHere sends the shopper back here; the order exists once PayHere's server notification has arrived. */
export default async function PayhereReturn() {
  const cart = await currentCart();
  return cart ? <WaitForOrder cartId={cart.id} /> : <p>Thank you. Your order is being processed.</p>;
}
