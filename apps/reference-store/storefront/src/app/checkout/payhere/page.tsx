import { redirect } from "next/navigation";
import { currentCart } from "@/lib/cart";
import { store } from "@/lib/medusa";
import { AutoSubmit } from "./auto-submit";

export const dynamic = "force-dynamic";

interface Session {
  provider_id: string;
  data: Record<string, unknown>;
}

/** Posts the server-signed PayHere form (hash computed by the backend) plus the shopper's details. */
export default async function PayherePage() {
  const cart = await currentCart();
  if (!cart) redirect("/cart");
  const { cart: full } = await store<{
    cart: {
      email: string | null;
      shipping_address: {
        first_name: string;
        last_name: string;
        phone: string;
        address_1: string;
        city: string;
      } | null;
      payment_collection: { payment_sessions: Session[] } | null;
      items: { title: string }[];
    };
  }>(`/store/carts/${cart.id}`, {
    query: {
      fields: "email,*shipping_address,*items,*payment_collection,*payment_collection.payment_sessions",
    },
  });
  const session = full.payment_collection?.payment_sessions.find(
    (s) => s.provider_id === "pp_payhere_payhere",
  );
  const address = full.shipping_address;
  if (!session || !address) redirect("/checkout");
  const data = session.data;
  const field = (name: string) => (typeof data[name] === "string" ? (data[name] as string) : "");
  const fields: Record<string, string> = {
    merchant_id: field("merchant_id"),
    return_url: field("return_url"),
    cancel_url: field("cancel_url"),
    notify_url: field("notify_url"),
    order_id: field("order_id"),
    items:
      full.items
        .map((item) => item.title)
        .join(", ")
        .slice(0, 200) || "Order",
    currency: field("currency"),
    amount: field("amount"),
    hash: field("hash"),
    first_name: address.first_name,
    last_name: address.last_name || "-",
    email: full.email ?? "no-reply@example.com",
    phone: address.phone,
    address: address.address_1,
    city: address.city,
    country: "Sri Lanka",
  };
  return <AutoSubmit action={field("checkout_url")} fields={fields} />;
}
