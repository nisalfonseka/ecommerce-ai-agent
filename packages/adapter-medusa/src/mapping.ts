import {
  type Availability,
  type Cart,
  type CartLine,
  type Image,
  type Order,
  type OrderOwner,
  type Product,
  toIsoDateTime,
  type Variant,
} from "@ace/contracts";
import { z } from "zod";
import { toMoney } from "./money";
import type { MedusaCart, MedusaOrder, MedusaProduct, MedusaVariant } from "./responses";

/** At or below this many units a variant is "low_stock" (same as the memory adapter). */
export const LOW_STOCK_THRESHOLD = 2;

/** Medusa's built-in manual provider, which the reference store uses for cash on delivery. */
export const COD_PROVIDER_ID = "pp_system_default";

const Attributes = z.record(z.string(), z.array(z.string()));

const isUrl = (value: string | null | undefined): value is string =>
  typeof value === "string" && URL.canParse(value) && /^https?:/.test(value);

export function variantStock(
  variant: Pick<MedusaVariant, "id" | "manage_inventory" | "allow_backorder" | "inventory_quantity">,
): { availability: Availability; quantityAvailable: number | null } {
  if (!variant.manage_inventory) return { availability: "in_stock", quantityAvailable: null };
  const quantity = Math.max(0, Math.floor(variant.inventory_quantity ?? 0));
  if (quantity === 0) {
    return { availability: variant.allow_backorder ? "backorder" : "out_of_stock", quantityAvailable: 0 };
  }
  return {
    availability: quantity <= LOW_STOCK_THRESHOLD ? "low_stock" : "in_stock",
    quantityAvailable: quantity,
  };
}

function variantOptions(variant: MedusaVariant, titles: Map<string, string>): Record<string, string> {
  const options: Record<string, string> = {};
  for (const value of variant.options ?? []) {
    const title = value.option?.title ?? titles.get(value.option_id ?? "");
    if (title) options[title.toLowerCase()] = value.value;
  }
  return options;
}

/**
 * A Medusa product as the contract sees it, or null when no variant has a price in the adapter's region
 * (Medusa then cannot sell it there, so for the agent it does not exist).
 */
export function toProduct(
  product: MedusaProduct,
  ctx: { storefrontUrl: string; currency: string },
): Product | null {
  const titles = new Map((product.options ?? []).map((option) => [option.id, option.title]));
  const variants: Variant[] = [];
  for (const variant of product.variants ?? []) {
    const amount = variant.calculated_price?.calculated_amount;
    if (amount === null || amount === undefined) continue;
    const currency = variant.calculated_price?.currency_code ?? ctx.currency;
    const options = variantOptions(variant, titles);
    const original = variant.calculated_price?.original_amount;
    variants.push({
      id: variant.id,
      productId: product.id,
      sku: variant.sku ?? undefined,
      title: variant.title || Object.values(options).join(" / ") || product.title,
      options,
      price: toMoney(amount, currency),
      compareAtPrice: original && original > amount ? toMoney(original, currency) : undefined,
      availability: variantStock(variant).availability,
    });
  }
  const [first] = variants;
  if (!first) return null;
  const amounts = variants.map((variant) => variant.price.amount);
  const currency = first.price.currency;
  const images: Image[] = (product.images ?? [])
    .map((image) => image.url)
    .filter(isUrl)
    .map((url) => ({ url, alt: product.title }));
  if (images.length === 0 && isUrl(product.thumbnail))
    images.push({ url: product.thumbnail, alt: product.title });
  const attributes = Attributes.safeParse(product.metadata?.attributes);
  const category = product.categories?.[0];
  return {
    id: product.id,
    handle: product.handle,
    title: product.title,
    description: product.description ?? "",
    url: `${ctx.storefrontUrl.replace(/\/+$/, "")}/products/${encodeURIComponent(product.handle)}`,
    category: category ? (category.handle ?? category.name) : undefined,
    tags: (product.tags ?? []).map((tag) => tag.value),
    attributes: attributes.success ? attributes.data : {},
    images,
    options: (product.options ?? [])
      .map((option) => ({
        name: option.title.toLowerCase(),
        values: (option.values ?? []).map((v) => v.value),
      }))
      .filter((option) => option.values.length > 0),
    variants,
    priceRange: {
      min: { amount: Math.min(...amounts), currency },
      max: { amount: Math.max(...amounts), currency },
    },
    updatedAt: toIsoDateTime(product.updated_at),
  };
}

export function toCart(cart: MedusaCart): Cart {
  const currency = cart.currency_code.toUpperCase();
  const lines: CartLine[] = (cart.items ?? []).flatMap((item) => {
    if (!item.variant_id || !item.product_id) return [];
    const unitPrice = toMoney(item.unit_price, currency);
    return [
      {
        id: item.id,
        productId: item.product_id,
        variantId: item.variant_id,
        title: item.product_title ?? item.title ?? "",
        variantTitle: item.variant_title ?? item.subtitle ?? "",
        quantity: item.quantity,
        unitPrice,
        lineTotal: { amount: unitPrice.amount * item.quantity, currency },
        image: isUrl(item.thumbnail) ? { url: item.thumbnail } : undefined,
      },
    ];
  });
  const attributes: Record<string, string> = {};
  for (const [key, value] of Object.entries(cart.metadata ?? {})) {
    if (typeof value === "string") attributes[key] = value;
  }
  return {
    id: cart.id,
    currency,
    lines,
    subtotal: { amount: lines.reduce((sum, line) => sum + line.lineTotal.amount, 0), currency },
    itemCount: lines.reduce((count, line) => count + line.quantity, 0),
    attributes,
    updatedAt: toIsoDateTime(cart.updated_at),
  };
}

function orderStatus(order: MedusaOrder): Order["status"] {
  if (order.status === "canceled") return "cancelled";
  switch (order.fulfillment_status) {
    case "delivered":
    case "partially_delivered":
      return "delivered";
    case "shipped":
    case "partially_shipped":
      return "shipped";
    case "fulfilled":
    case "partially_fulfilled":
      return "processing";
  }
  if (order.status === "completed") return "delivered";
  return ["authorized", "partially_authorized", "captured", "partially_captured"].includes(
    order.payment_status ?? "",
  )
    ? "confirmed"
    : "pending";
}

function paymentStatus(order: MedusaOrder): Order["paymentStatus"] {
  const providers = (order.payment_collections ?? []).flatMap((collection) =>
    (collection.payments ?? []).map((payment) => payment.provider_id),
  );
  switch (order.payment_status) {
    case "captured":
    case "partially_captured":
      return "paid";
    case "refunded":
    case "partially_refunded":
      return "refunded";
    case "canceled":
      return "failed";
    case "authorized":
    case "partially_authorized":
      return providers.includes(COD_PROVIDER_ID) ? "cod_pending" : "pending";
    default:
      return "pending";
  }
}

/** Null for an order without lines, which the contract cannot represent. */
export function toOrder(order: MedusaOrder): Order | null {
  const currency = order.currency_code.toUpperCase();
  const lines = (order.items ?? []).map((item) => ({
    title: item.product_title ?? item.title ?? "",
    variantTitle: item.variant_title ?? item.subtitle ?? "",
    quantity: item.quantity,
    unitPrice: toMoney(item.unit_price, currency),
  }));
  if (lines.length === 0) return null;
  return {
    id: order.id,
    number: String(order.display_id),
    status: orderStatus(order),
    paymentStatus: paymentStatus(order),
    placedAt: toIsoDateTime(order.created_at),
    total: toMoney(order.total, currency),
    lines,
    tracking: (order.fulfillments ?? []).flatMap((fulfillment) =>
      (fulfillment.labels ?? []).map((label) => ({
        carrier: "Courier",
        number: label.tracking_number,
        url: isUrl(label.tracking_url) ? label.tracking_url : undefined,
      })),
    ),
  };
}

export function orderOwner(order: MedusaOrder): OrderOwner {
  return {
    email: order.email ?? undefined,
    phone: order.shipping_address?.phone ?? undefined,
    externalCustomerId: order.customer_id ?? undefined,
  };
}
