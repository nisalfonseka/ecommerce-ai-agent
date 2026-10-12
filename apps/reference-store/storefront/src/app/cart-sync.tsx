"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { CART_COOKIE, CART_COOKIE_MAX_AGE } from "@/lib/cart-cookie";

type AceQueue = { q?: unknown[][]; setCart?: (cartId: string | null) => void };
declare global {
  interface Window {
    ACE?: AceQueue;
  }
}

function readCartCookie(): string | null {
  const match = document.cookie.split("; ").find((part) => part.startsWith(`${CART_COOKIE}=`));
  return match ? decodeURIComponent(match.slice(CART_COOKIE.length + 1)) : null;
}

/**
 * The header cart badge, and one cart for the site and the assistant (spec G2): the site's cart id goes to the
 * widget (ACE.setCart), and a cart the assistant creates becomes the site's cart.
 */
export function CartSync({
  initialCount,
  cartId,
  assistant,
}: {
  initialCount: number;
  /** The site's open cart, from the server render; re-sent to the widget whenever it changes. */
  cartId: string | null;
  assistant: boolean;
}) {
  const router = useRouter();
  const [count, setCount] = useState(initialCount);
  useEffect(() => setCount(initialCount), [initialCount]);

  useEffect(() => {
    if (!assistant) return;
    if (window.ACE?.setCart) window.ACE.setCart(cartId);
    else {
      window.ACE = window.ACE ?? { q: [] };
      window.ACE.q = window.ACE.q ?? [];
      window.ACE.q.push(["setCart", cartId]);
    }
  }, [assistant, cartId]);

  useEffect(() => {
    if (!assistant) return;
    const onUpdate = (event: Event) => {
      const detail = (event as CustomEvent<{ cartId: string | null; itemCount: number | null }>).detail;
      if (detail.cartId && detail.cartId !== readCartCookie()) {
        // biome-ignore lint/suspicious/noDocumentCookie: one non-httpOnly cookie shared with the server render.
        document.cookie = `${CART_COOKIE}=${encodeURIComponent(detail.cartId)}; path=/; max-age=${CART_COOKIE_MAX_AGE}; samesite=lax`;
      }
      if (detail.itemCount !== null) setCount(detail.itemCount);
      router.refresh();
    };
    window.addEventListener("ace:cart-updated", onUpdate);
    return () => window.removeEventListener("ace:cart-updated", onUpdate);
  }, [assistant, router]);

  return (
    <span className="badge" data-testid="cart-count" aria-live="polite">
      {count}
    </span>
  );
}
