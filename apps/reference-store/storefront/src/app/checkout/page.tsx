import { redirect } from "next/navigation";
import { currentCart } from "@/lib/cart";
import { formatPrice, REGION_ID, store } from "@/lib/medusa";
import { CheckoutForm } from "./checkout-form";

export const dynamic = "force-dynamic";

export default async function CheckoutPage({
  searchParams,
}: {
  searchParams: Promise<{ payhere?: string }>;
}) {
  const cart = await currentCart();
  if (!cart || cart.items.length === 0) redirect("/cart");
  const { payment_providers } = await store<{ payment_providers: { id: string }[] }>(
    "/store/payment-providers",
    {
      query: { region_id: REGION_ID },
    },
  );
  const payhere = payment_providers.some((provider) => provider.id === "pp_payhere_payhere");
  const cancelled = (await searchParams).payhere === "cancelled";
  return (
    <>
      <h2>Checkout</h2>
      <ul>
        {cart.items.map((item) => (
          <li key={item.id}>
            {item.quantity} × {item.product_title ?? item.title} · {item.variant_title} —{" "}
            {formatPrice(item.unit_price * item.quantity, cart.currency_code)}
          </li>
        ))}
      </ul>
      <p>
        Subtotal <span className="price">{formatPrice(cart.item_subtotal, cart.currency_code)}</span>{" "}
        <span className="muted">(delivery added at the next step)</span>
      </p>
      {cancelled ? (
        <p className="error">The card payment was cancelled. You can try again or pay on delivery.</p>
      ) : null}
      <CheckoutForm payhere={payhere} />
    </>
  );
}
