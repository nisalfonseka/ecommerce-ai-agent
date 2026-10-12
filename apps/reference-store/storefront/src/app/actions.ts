"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { currentCart, ensureCart, setCartCookie } from "@/lib/cart";
import { type Cart, cartFields, MedusaError, store } from "@/lib/medusa";

export type ActionState = { error: string | null };

function message(error: unknown): string {
  if (error instanceof MedusaError && error.body?.code === "insufficient_inventory") {
    return "Sorry, there is not enough stock for that.";
  }
  return "Something went wrong. Please try again.";
}

export async function addToCart(_state: ActionState, form: FormData): Promise<ActionState> {
  const variantId = String(form.get("variantId") ?? "");
  if (!variantId) return { error: "Choose a size." };
  try {
    const cart = await ensureCart();
    await store(`/store/carts/${cart.id}/line-items`, {
      method: "POST",
      body: { variant_id: variantId, quantity: 1 },
      query: cartFields(),
    });
  } catch (error) {
    return { error: message(error) };
  }
  revalidatePath("/", "layout");
  return { error: null };
}

export async function updateLine(form: FormData): Promise<void> {
  const cart = await currentCart();
  const lineId = String(form.get("lineId") ?? "");
  const quantity = Number(form.get("quantity"));
  if (!cart || !lineId || !Number.isInteger(quantity) || quantity < 0) return;
  const path = `/store/carts/${cart.id}/line-items/${encodeURIComponent(lineId)}`;
  try {
    if (quantity === 0) await store(path, { method: "DELETE" });
    else await store(path, { method: "POST", body: { quantity }, query: cartFields() });
  } catch {
    // Out of stock: the page shows the unchanged cart.
  }
  revalidatePath("/", "layout");
}

const text = (form: FormData, name: string) => String(form.get(name) ?? "").trim();

/** Checkout: address → cheapest delivery → payment session → COD completes now; PayHere hands over to PayHere. */
export async function placeOrder(_state: ActionState, form: FormData): Promise<ActionState> {
  const cart = await currentCart();
  if (!cart || cart.items.length === 0) return { error: "Your cart is empty." };
  const [first, ...rest] = text(form, "name").split(/\s+/);
  const address = {
    first_name: first ?? "",
    last_name: rest.join(" "),
    phone: text(form, "phone"),
    address_1: text(form, "address"),
    city: text(form, "city"),
    country_code: "lk",
  };
  if (!address.first_name || !address.phone || !address.address_1 || !address.city) {
    return { error: "Please fill in your name, phone, address and city." };
  }
  const payment = text(form, "payment") === "payhere" ? "payhere" : "cod";
  const email = text(form, "email");
  let target: string;
  try {
    await store(`/store/carts/${cart.id}`, {
      method: "POST",
      body: { ...(email ? { email } : {}), shipping_address: address, billing_address: address },
      query: cartFields(),
    });
    const { shipping_options } = await store<{ shipping_options: { id: string; amount: number }[] }>(
      "/store/shipping-options",
      { query: { cart_id: cart.id } },
    );
    const cheapest = [...shipping_options].sort((a, b) => a.amount - b.amount)[0];
    if (!cheapest) return { error: "We cannot deliver this order. Please contact us." };
    await store(`/store/carts/${cart.id}/shipping-methods`, {
      method: "POST",
      body: { option_id: cheapest.id },
      query: cartFields(),
    });
    const { payment_collection } = await store<{ payment_collection: { id: string } }>(
      "/store/payment-collections",
      { method: "POST", body: { cart_id: cart.id } },
    );
    await store(`/store/payment-collections/${payment_collection.id}/payment-sessions`, {
      method: "POST",
      body: { provider_id: payment === "payhere" ? "pp_payhere_payhere" : "pp_system_default" },
    });
    if (payment === "payhere") {
      target = "/checkout/payhere";
    } else {
      const done = await store<{ type: string; order?: { display_id: number } }>(
        `/store/carts/${cart.id}/complete`,
        { method: "POST" },
      );
      if (done.type !== "order" || !done.order)
        return { error: "We could not place the order. Please try again." };
      await setCartCookie(null);
      target = `/order/confirmed?number=${done.order.display_id}`;
    }
  } catch (error) {
    return { error: message(error) };
  }
  revalidatePath("/", "layout");
  redirect(target);
}

/** PayHere return page: the order exists once PayHere's notification reached the backend. */
export async function completeAfterPayhere(cartId: string): Promise<{ number: number } | null> {
  try {
    const done = await store<{ type: string; order?: { display_id: number } }>(
      `/store/carts/${encodeURIComponent(cartId)}/complete`,
      { method: "POST" },
    );
    if (done.type === "order" && done.order) {
      await setCartCookie(null);
      return { number: done.order.display_id };
    }
  } catch {
    // Not authorized yet: PayHere has not notified the backend.
  }
  return null;
}

export type { Cart };
