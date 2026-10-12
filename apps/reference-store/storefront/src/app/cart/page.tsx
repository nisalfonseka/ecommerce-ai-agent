import Link from "next/link";
import { currentCart } from "@/lib/cart";
import { formatPrice } from "@/lib/medusa";
import { updateLine } from "../actions";

export const dynamic = "force-dynamic";

export default async function CartPage() {
  const cart = await currentCart();
  if (!cart || cart.items.length === 0) {
    return (
      <p>
        Your cart is empty. <Link href="/">Browse the store</Link>.
      </p>
    );
  }
  return (
    <>
      <h2>Your cart</h2>
      <table>
        <tbody>
          {cart.items.map((item) => (
            <tr key={item.id}>
              <td>
                {item.product_title ?? item.title} · {item.variant_title}
              </td>
              <td>
                <form action={updateLine} style={{ display: "inline" }}>
                  <input type="hidden" name="lineId" value={item.id} />
                  <input type="hidden" name="quantity" value={item.quantity - 1} />
                  <button className="secondary" type="submit" aria-label={`One fewer ${item.title}`}>
                    −
                  </button>
                </form>{" "}
                {item.quantity}{" "}
                <form action={updateLine} style={{ display: "inline" }}>
                  <input type="hidden" name="lineId" value={item.id} />
                  <input type="hidden" name="quantity" value={item.quantity + 1} />
                  <button className="secondary" type="submit" aria-label={`One more ${item.title}`}>
                    +
                  </button>
                </form>
              </td>
              <td className="price">{formatPrice(item.unit_price * item.quantity, cart.currency_code)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="price">Subtotal {formatPrice(cart.item_subtotal, cart.currency_code)}</p>
      <Link className="button" href="/checkout">
        Checkout
      </Link>
    </>
  );
}
