import { z } from "zod";

/**
 * The parts of Medusa v2 responses the adapter reads. Everything else is ignored (zod strips unknown keys), so
 * additive Medusa changes do not break the adapter. Amounts are major units.
 */
const Amount = z.number();
const Metadata = z.record(z.string(), z.unknown()).nullish();
const Timestamp = z.union([z.string(), z.date()]);

export const MedusaVariant = z.object({
  id: z.string(),
  title: z.string().nullish(),
  sku: z.string().nullish(),
  product_id: z.string().nullish(),
  manage_inventory: z.boolean().nullish(),
  allow_backorder: z.boolean().nullish(),
  inventory_quantity: z.number().nullish(),
  options: z
    .array(
      z.object({
        value: z.string(),
        option_id: z.string().nullish(),
        option: z.object({ id: z.string(), title: z.string() }).nullish(),
      }),
    )
    .nullish(),
  calculated_price: z
    .object({
      calculated_amount: Amount.nullish(),
      original_amount: Amount.nullish(),
      currency_code: z.string().nullish(),
    })
    .nullish(),
  updated_at: Timestamp.nullish(),
});
export type MedusaVariant = z.infer<typeof MedusaVariant>;

export const MedusaProduct = z.object({
  id: z.string(),
  handle: z.string(),
  title: z.string(),
  description: z.string().nullish(),
  thumbnail: z.string().nullish(),
  updated_at: Timestamp,
  metadata: Metadata,
  images: z.array(z.object({ url: z.string() })).nullish(),
  options: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        values: z.array(z.object({ value: z.string() })).nullish(),
      }),
    )
    .nullish(),
  categories: z.array(z.object({ id: z.string(), handle: z.string().nullish(), name: z.string() })).nullish(),
  tags: z.array(z.object({ value: z.string() })).nullish(),
  variants: z.array(MedusaVariant).nullish(),
});
export type MedusaProduct = z.infer<typeof MedusaProduct>;

export const MedusaLineItem = z.object({
  id: z.string(),
  title: z.string().nullish(),
  subtitle: z.string().nullish(),
  thumbnail: z.string().nullish(),
  quantity: z.number(),
  variant_id: z.string().nullish(),
  product_id: z.string().nullish(),
  product_title: z.string().nullish(),
  variant_title: z.string().nullish(),
  unit_price: Amount,
});

export const MedusaCart = z.object({
  id: z.string(),
  currency_code: z.string(),
  region_id: z.string().nullish(),
  metadata: Metadata,
  updated_at: Timestamp,
  completed_at: Timestamp.nullish(),
  items: z.array(MedusaLineItem).nullish(),
});
export type MedusaCart = z.infer<typeof MedusaCart>;

export const MedusaOrder = z.object({
  id: z.string(),
  display_id: z.union([z.number(), z.string()]),
  status: z.string(),
  payment_status: z.string().nullish(),
  fulfillment_status: z.string().nullish(),
  email: z.string().nullish(),
  customer_id: z.string().nullish(),
  created_at: Timestamp,
  total: Amount,
  currency_code: z.string(),
  metadata: Metadata,
  shipping_address: z.object({ phone: z.string().nullish() }).nullish(),
  items: z
    .array(
      z.object({
        title: z.string().nullish(),
        subtitle: z.string().nullish(),
        product_title: z.string().nullish(),
        variant_title: z.string().nullish(),
        quantity: z.number(),
        unit_price: Amount,
      }),
    )
    .nullish(),
  payment_collections: z
    .array(z.object({ payments: z.array(z.object({ provider_id: z.string() })).nullish() }))
    .nullish(),
  fulfillments: z
    .array(
      z.object({
        provider_id: z.string().nullish(),
        labels: z
          .array(z.object({ tracking_number: z.string(), tracking_url: z.string().nullish() }))
          .nullish(),
      }),
    )
    .nullish(),
});
export type MedusaOrder = z.infer<typeof MedusaOrder>;

export const MedusaRegion = z.object({
  id: z.string(),
  currency_code: z.string(),
  countries: z.array(z.object({ iso_2: z.string() })).nullish(),
});
export type MedusaRegion = z.infer<typeof MedusaRegion>;

export const MedusaShippingOption = z.object({
  id: z.string(),
  name: z.string(),
  amount: Amount.nullish(),
  calculated_price: z.object({ calculated_amount: Amount.nullish() }).nullish(),
});

export const ProductsResponse = z.object({ products: z.array(MedusaProduct), count: z.number().nullish() });
export const ProductResponse = z.object({ product: MedusaProduct });
export const VariantsResponse = z.object({ variants: z.array(MedusaVariant) });
export const CartResponse = z.object({ cart: MedusaCart });
export const DeleteLineResponse = z.object({ parent: MedusaCart });
export const RegionResponse = z.object({ region: MedusaRegion });
export const OrdersResponse = z.object({ orders: z.array(MedusaOrder) });
export const OrderResponse = z.object({ order: MedusaOrder });
export const ShippingOptionsResponse = z.object({ shipping_options: z.array(MedusaShippingOption) });
export const PaymentCollectionResponse = z.object({ payment_collection: z.object({ id: z.string() }) });
export const CompleteCartResponse = z.union([
  z.object({ type: z.literal("order"), order: z.object({ id: z.string() }) }),
  z.object({ type: z.literal("cart"), error: z.unknown().optional() }),
]);
export const CategoriesResponse = z.object({
  product_categories: z.array(z.object({ id: z.string(), handle: z.string().nullish(), name: z.string() })),
});
export const InventoryItemsResponse = z.object({
  inventory_items: z.array(
    z.object({
      id: z.string(),
      location_levels: z
        .array(z.object({ location_id: z.string(), reserved_quantity: z.number().nullish() }))
        .nullish(),
    }),
  ),
});
