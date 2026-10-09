import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { currentCart } from "@/lib/cart";
import { CartSync } from "./cart-sync";
import "./globals.css";

export const metadata: Metadata = {
  title: "Reference Store",
  description: "Clothing, delivered island-wide.",
};

const WIDGET_KEY = process.env.NEXT_PUBLIC_ACE_WIDGET_KEY ?? "";
const WIDGET_API = process.env.NEXT_PUBLIC_ACE_API ?? "";
const WIDGET_SRC = process.env.NEXT_PUBLIC_ACE_WIDGET_SRC ?? "/ace.js";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const cart = await currentCart();
  const count = cart?.items.reduce((sum, item) => sum + item.quantity, 0) ?? 0;
  return (
    <html lang="en">
      <body>
        <header className="site">
          <h1>
            <Link href="/">Reference Store</Link>
          </h1>
          <Link href="/cart">
            Cart <CartSync initialCount={count} cartId={cart?.id ?? null} assistant={WIDGET_KEY !== ""} />
          </Link>
        </header>
        <main>{children}</main>
        {WIDGET_KEY ? (
          // The shopping assistant: one script tag (Phase 4). Its cart is this site's cart (CartSync).
          <script src={WIDGET_SRC} data-key={WIDGET_KEY} data-api={WIDGET_API} async />
        ) : null}
      </body>
    </html>
  );
}
