import type {
  Availability,
  Cart,
  CheckoutHandoff,
  Money,
  Order,
  Product,
  ProductSummary,
} from "@ace/contracts";

/** A size/colour the shopper can pick on a card; live price and stock. */
export interface VariantChoice {
  variantId: string;
  title: string;
  options: Record<string, string>;
  price: Money;
  availability: Availability;
}

/** Structured parts the channel renders. Prices and links shown to shoppers come from here, never from model text. */
export type UiPart =
  | { type: "product_list"; items: (ProductSummary & { ref: string; variants: VariantChoice[] })[] }
  | { type: "product_detail"; product: Product }
  | { type: "cart"; cart: Cart }
  | { type: "checkout"; checkout: CheckoutHandoff }
  | { type: "order"; order: Order }
  | { type: "verification_required"; reason: string };
