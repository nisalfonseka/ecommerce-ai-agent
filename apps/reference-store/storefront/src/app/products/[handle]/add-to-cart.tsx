"use client";

import { useActionState } from "react";
import { type ActionState, addToCart } from "@/app/actions";

interface Choice {
  id: string;
  title: string;
  price: string | null;
  soldOut: boolean;
}

export function AddToCart({ variants }: { variants: Choice[] }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(addToCart, { error: null });
  return (
    <form action={action}>
      <fieldset className="sizes">
        <legend>Size</legend>
        {variants.map((variant) => (
          <label key={variant.id}>
            <input type="radio" name="variantId" value={variant.id} disabled={variant.soldOut} required />
            {variant.title} {variant.price ? `· ${variant.price}` : ""} {variant.soldOut ? "(sold out)" : ""}
          </label>
        ))}
      </fieldset>
      <button type="submit" disabled={pending}>
        Add to cart
      </button>
      {state.error ? <p className="error">{state.error}</p> : null}
    </form>
  );
}
