import type {
  Availability,
  Cart,
  CartLine,
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
  | { type: "verification_required"; reason: string }
  /** Cash on delivery: the form the shopper fills in (never the model). `prefill` re-opens a draft for editing. */
  | {
      type: "delivery_form";
      cartId: string;
      countryCode: string;
      cities: string[] | null;
      prefill: DeliveryPrefill | null;
    }
  /** Cash on delivery: what the shopper confirms. The Confirm button is the only way to place the order. */
  | {
      type: "cod_summary";
      cartId: string;
      countryCode: string;
      lines: CartLine[];
      subtotal: Money;
      deliveryFee: Money;
      total: Money;
      deliverTo: DeliveryPrefill;
    };

export interface DeliveryPrefill {
  name: string;
  phone: string;
  email?: string | undefined;
  line1: string;
  line2?: string | undefined;
  city: string;
  district?: string | undefined;
  postalCode?: string | undefined;
  note?: string | undefined;
}
