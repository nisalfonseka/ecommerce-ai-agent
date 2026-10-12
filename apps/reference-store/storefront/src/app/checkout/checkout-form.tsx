"use client";

import { useActionState } from "react";
import { type ActionState, placeOrder } from "../actions";

export function CheckoutForm({ payhere }: { payhere: boolean }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(placeOrder, { error: null });
  return (
    <form className="checkout" action={action}>
      <label>
        Full name
        <input name="name" autoComplete="name" required maxLength={120} />
      </label>
      <label>
        Phone
        <input name="phone" type="tel" autoComplete="tel" required maxLength={20} />
      </label>
      <label>
        Email (optional)
        <input name="email" type="email" autoComplete="email" maxLength={254} />
      </label>
      <label>
        Address
        <input name="address" autoComplete="address-line1" required maxLength={200} />
      </label>
      <label>
        City
        <input name="city" autoComplete="address-level2" required maxLength={80} />
      </label>
      <fieldset>
        <legend>Payment</legend>
        <label>
          <input type="radio" name="payment" value="cod" defaultChecked /> Cash on delivery
        </label>
        {payhere ? (
          <label>
            <input type="radio" name="payment" value="payhere" /> Card (PayHere)
          </label>
        ) : null}
      </fieldset>
      <button type="submit" disabled={pending}>
        Place order
      </button>
      {state.error ? <p className="error">{state.error}</p> : null}
    </form>
  );
}
