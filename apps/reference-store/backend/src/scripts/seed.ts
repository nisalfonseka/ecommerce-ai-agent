import { writeFileSync } from "node:fs";
import type { ExecArgs } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules, ProductStatus } from "@medusajs/framework/utils";
import {
  createApiKeysWorkflow,
  createInventoryLevelsWorkflow,
  createOrderWorkflow,
  createProductCategoriesWorkflow,
  createProductsWorkflow,
  createProductTagsWorkflow,
  createRegionsWorkflow,
  createSalesChannelsWorkflow,
  createShippingOptionsWorkflow,
  createShippingProfilesWorkflow,
  createStockLocationsWorkflow,
  createTaxRegionsWorkflow,
  linkSalesChannelsToApiKeyWorkflow,
  linkSalesChannelsToStockLocationWorkflow,
  updateStoresWorkflow,
} from "@medusajs/medusa/core-flows";
import { CATALOG, DELIVERY_FEE_LKR, FIXTURE_CUSTOMER, sku } from "./catalog";

const COUNTRY = "lk";
const CURRENCY = "lkr";

/**
 * Seeds an empty database with the generic Sri Lankan reference store (ADR-006): LKR region, web sales channel,
 * keys, island-wide delivery, the clothing catalog with stock, and one order for the order-lookup fixtures.
 * It refuses to run twice (scripts/reference-store.sh recreates the database). The keys and fixture IDs are
 * written as JSON to $SEED_OUTPUT (default seed-output.json), which holds a secret key: keep it out of git.
 */
export default async function seed({ container }: ExecArgs): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER);
  const link = container.resolve(ContainerRegistrationKeys.LINK);
  const query = container.resolve(ContainerRegistrationKeys.QUERY);
  const fulfillment = container.resolve(Modules.FULFILLMENT);
  const storeModule = container.resolve(Modules.STORE);
  const regionModule = container.resolve(Modules.REGION);

  if ((await regionModule.listRegions({ name: "Sri Lanka" })).length > 0) {
    throw new Error("The store is already seeded; recreate the database to seed again.");
  }

  const [store] = await storeModule.listStores();
  if (!store) throw new Error("Medusa created no default store; run the migrations first.");

  const {
    result: [channel],
  } = await createSalesChannelsWorkflow(container).run({
    input: { salesChannelsData: [{ name: "Web", description: "Reference storefront" }] },
  });
  if (!channel) throw new Error("sales channel not created");

  await updateStoresWorkflow(container).run({
    input: {
      selector: { id: store.id },
      update: {
        name: "Reference Store",
        supported_currencies: [{ currency_code: CURRENCY, is_default: true, is_tax_inclusive: true }],
        default_sales_channel_id: channel.id,
      },
    },
  });

  const {
    result: [region],
  } = await createRegionsWorkflow(container).run({
    input: {
      regions: [
        {
          name: "Sri Lanka",
          currency_code: CURRENCY,
          countries: [COUNTRY],
          automatic_taxes: false,
          is_tax_inclusive: true,
          payment_providers: [
            "pp_system_default",
            ...(process.env.PAYHERE_MERCHANT_ID ? ["pp_payhere_payhere"] : []),
          ],
        },
      ],
    },
  });
  if (!region) throw new Error("region not created");
  await createTaxRegionsWorkflow(container).run({
    input: [{ country_code: COUNTRY, provider_id: "tp_system" }],
  });

  // Delivery: one warehouse, island-wide flat fee.
  const {
    result: [location],
  } = await createStockLocationsWorkflow(container).run({
    input: {
      locations: [
        { name: "Colombo warehouse", address: { address_1: "", city: "Colombo", country_code: COUNTRY } },
      ],
    },
  });
  if (!location) throw new Error("stock location not created");
  await link.create({
    [Modules.STOCK_LOCATION]: { stock_location_id: location.id },
    [Modules.FULFILLMENT]: { fulfillment_provider_id: "manual_manual" },
  });
  let [profile] = await fulfillment.listShippingProfiles({ type: "default" });
  if (!profile) {
    const { result } = await createShippingProfilesWorkflow(container).run({
      input: { data: [{ name: "Default", type: "default" }] },
    });
    profile = result[0];
  }
  if (!profile) throw new Error("shipping profile not created");
  const deliverySet = await fulfillment.createFulfillmentSets({
    name: "Island-wide delivery",
    type: "shipping",
    service_zones: [{ name: "Sri Lanka", geo_zones: [{ country_code: COUNTRY, type: "country" }] }],
  });
  const zone = deliverySet.service_zones[0];
  if (!zone) throw new Error("service zone not created");
  await link.create({
    [Modules.STOCK_LOCATION]: { stock_location_id: location.id },
    [Modules.FULFILLMENT]: { fulfillment_set_id: deliverySet.id },
  });
  const {
    result: [delivery],
  } = await createShippingOptionsWorkflow(container).run({
    input: [
      {
        name: "Island-wide delivery",
        price_type: "flat",
        provider_id: "manual_manual",
        service_zone_id: zone.id,
        shipping_profile_id: profile.id,
        type: { label: "Standard", description: "Delivered in 2–4 working days.", code: "standard" },
        prices: [
          { currency_code: CURRENCY, amount: DELIVERY_FEE_LKR },
          { region_id: region.id, amount: DELIVERY_FEE_LKR },
        ],
        rules: [
          { attribute: "enabled_in_store", value: "true", operator: "eq" },
          { attribute: "is_return", value: "false", operator: "eq" },
        ],
      },
    ],
  });
  if (!delivery) throw new Error("shipping option not created");
  await linkSalesChannelsToStockLocationWorkflow(container).run({
    input: { id: location.id, add: [channel.id] },
  });

  // Keys: publishable for the Store API, secret for the adapter's Admin API calls.
  const { result: keys } = await createApiKeysWorkflow(container).run({
    input: {
      api_keys: [
        { title: "Storefront and assistant", type: "publishable", created_by: "seed" },
        { title: "Assistant adapter", type: "secret", created_by: "seed" },
      ],
    },
  });
  const publishable = keys.find((key) => key.type === "publishable");
  const secret = keys.find((key) => key.type === "secret");
  if (!publishable || !secret) throw new Error("api keys not created");
  await linkSalesChannelsToApiKeyWorkflow(container).run({
    input: { id: publishable.id, add: [channel.id] },
  });

  // Catalog.
  const categoryNames = [...new Set(CATALOG.map((product) => product.category))];
  const { result: categories } = await createProductCategoriesWorkflow(container).run({
    input: {
      product_categories: categoryNames.map((name) => ({ name, handle: name, is_active: true })),
    },
  });
  const tagValues = [...new Set(CATALOG.flatMap((product) => product.tags))];
  const { result: tags } = await createProductTagsWorkflow(container).run({
    input: { product_tags: tagValues.map((value) => ({ value })) },
  });
  const storefront = process.env.STOREFRONT_URL ?? "http://localhost:8000";
  await createProductsWorkflow(container).run({
    input: {
      products: CATALOG.map((product) => ({
        title: product.title,
        handle: product.handle,
        description: product.description,
        status: ProductStatus.PUBLISHED,
        shipping_profile_id: profile.id,
        category_ids: categories.filter((c) => c.handle === product.category).map((c) => c.id),
        tag_ids: tags.filter((t) => product.tags.includes(t.value)).map((t) => t.id),
        thumbnail: `${storefront}/images/${product.handle}.svg`,
        images: [{ url: `${storefront}/images/${product.handle}.svg` }],
        metadata: { attributes: product.attributes },
        options: [
          { title: "Color", values: [product.color] },
          { title: "Size", values: Object.keys(product.sizes) },
        ],
        variants: Object.keys(product.sizes).map((size) => ({
          title: `${product.color} / ${size}`,
          sku: sku(product.handle, size),
          manage_inventory: true,
          options: { Color: product.color, Size: size },
          prices: [{ currency_code: CURRENCY, amount: product.priceLkr }],
        })),
        sales_channels: [{ id: channel.id }],
      })),
    },
  });

  const stockBySku = new Map(
    CATALOG.flatMap((product) =>
      Object.entries(product.sizes).map(([size, units]) => [sku(product.handle, size), units] as const),
    ),
  );
  const { data: items } = await query.graph({ entity: "inventory_item", fields: ["id", "sku"] });
  await createInventoryLevelsWorkflow(container).run({
    input: {
      inventory_levels: items.map((item) => ({
        location_id: location.id,
        inventory_item_id: item.id,
        stocked_quantity: stockBySku.get(item.sku ?? "") ?? 0,
      })),
    },
  });

  const { data: variants } = await query.graph({
    entity: "product_variant",
    fields: ["id", "sku", "title", "product.id", "product.title"],
  });
  const variantBySku = new Map(variants.map((variant) => [variant.sku ?? "", variant]));
  const need = (code: string) => {
    const variant = variantBySku.get(code);
    if (!variant) throw new Error(`variant ${code} not found`);
    return variant;
  };

  // The order-lookup fixture: one existing order for the fixture customer.
  const fixtureVariant = need(sku("wrap-dress-black", "S"));
  const address = {
    first_name: "Demo",
    last_name: "Customer",
    address_1: "12 Galle Road",
    city: "Colombo",
    country_code: COUNTRY,
    phone: FIXTURE_CUSTOMER.phone,
  };
  const { result: order } = await createOrderWorkflow(container).run({
    input: {
      region_id: region.id,
      sales_channel_id: channel.id,
      currency_code: CURRENCY,
      email: FIXTURE_CUSTOMER.email,
      shipping_address: address,
      billing_address: address,
      items: [
        {
          title: fixtureVariant.product?.title ?? "Black Satin Wrap Dress",
          variant_id: fixtureVariant.id,
          quantity: 1,
          unit_price: 18500,
        },
      ],
      metadata: { seed: true },
    },
  });

  const inStock = need(sku("wrap-dress-black", "M"));
  const output = {
    backendUrl: process.env.BACKEND_URL ?? "http://localhost:9000",
    storefrontUrl: storefront,
    publishableKey: publishable.token,
    secretKey: secret.token,
    regionId: region.id,
    salesChannelId: channel.id,
    stockLocationId: location.id,
    fixtures: {
      searchTerm: "black",
      productId: inStock.product?.id,
      inStockVariantId: inStock.id,
      inStockQuantity: stockBySku.get(sku("wrap-dress-black", "M")),
      outOfStockVariantId: need(sku("linen-shirt-black", "L")).id,
      orderNumber: String(order.display_id),
      orderOwnerEmail: FIXTURE_CUSTOMER.email,
    },
  };
  const path = process.env.SEED_OUTPUT ?? "seed-output.json";
  writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
  logger.info(`Reference store seeded; keys and fixtures written to ${path}`);
}
