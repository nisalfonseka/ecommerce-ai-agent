import type { Cart, CheckoutHandoff, Order, Product, ProductSummary } from "@ace/contracts";

/** Structured parts the channel renders. Prices and links shown to shoppers come from here, never from model text. */
export type UiPart =
  | { type: "product_list"; items: (ProductSummary & { ref: string })[] }
  | { type: "product_detail"; product: Product }
  | { type: "cart"; cart: Cart }
  | { type: "checkout"; checkout: CheckoutHandoff }
  | { type: "order"; order: Order }
  | { type: "verification_required"; reason: string };
