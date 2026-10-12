import {
  type AddCartLinesInput,
  AddCartLinesInputSchema,
  CAPABILITIES,
  type Capability,
  type Cart,
  type CheckoutHandoff,
  type CodDetails,
  type CodDetailsInput,
  CodDetailsSchema,
  type CodQuote,
  CommerceError,
  type CommerceProvider,
  type CreateCartInput,
  CreateCartInputSchema,
  GetInventoryInputSchema,
  type InventoryLevel,
  identityMatches,
  type ListOrdersInput,
  ListOrdersInputSchema,
  type ListProductsInput,
  ListProductsInputSchema,
  type ListProductsResult,
  type LookupOrderInput,
  LookupOrderInputSchema,
  MAX_LINE_QUANTITY,
  type Order,
  type Product,
  parseInput,
  type SearchProductsInput,
  SearchProductsInputSchema,
  type SearchProductsResult,
  type UpdateCartAttributesInput,
  UpdateCartAttributesInputSchema,
  type UpdateCartLineInput,
  UpdateCartLineInputSchema,
  type WriteOptions,
  WriteOptionsSchema,
} from "@ace/contracts";
import { z } from "zod";
import { MedusaHttp } from "./http";
import { COD_PROVIDER_ID, orderOwner, toCart, toOrder, toProduct, variantStock } from "./mapping";
import { toMoney } from "./money";
import {
  CartResponse,
  CategoriesResponse,
  CompleteCartResponse,
  type MedusaCart,
  type MedusaOrder,
  type MedusaProduct,
  type MedusaRegion,
  type MedusaVariant,
  OrderResponse,
  OrdersResponse,
  PaymentCollectionResponse,
  ProductResponse,
  ProductsResponse,
  RegionResponse,
  ShippingOptionsResponse,
  VariantsResponse,
} from "./responses";
import { decodeCursor, encodeCursor, rankProducts, words } from "./search";

export const MedusaProviderOptionsSchema = z.object({
  /** Medusa backend, e.g. https://store-api.example.lk */
  baseUrl: z.url(),
  publishableKey: z.string().min(1),
  /** Admin API secret key: order lookup and inventory. */
  secretKey: z.string().min(1),
  /** The region whose prices and currency the assistant quotes. */
  regionId: z.string().min(1),
  /** Storefront base URL for product links and the checkout handoff. */
  storefrontUrl: z.url(),
  timeoutMs: z.number().int().positive().default(10_000),
});
export type MedusaProviderOptions = z.input<typeof MedusaProviderOptionsSchema> & { fetch?: typeof fetch };

const PRODUCT_FIELDS = [
  "id,handle,title,description,thumbnail,updated_at,+metadata",
  "*images,*options,*options.values,*categories,*tags",
  "*variants,*variants.options,*variants.options.option,*variants.calculated_price,+variants.inventory_quantity",
].join(",");
const CART_FIELDS = "id,currency_code,region_id,metadata,updated_at,completed_at,*items";
const VARIANT_FIELDS = "id,sku,title,product_id,manage_inventory,allow_backorder,+inventory_quantity";
const ORDER_FIELDS = [
  "id,display_id,status,payment_status,fulfillment_status,email,customer_id,created_at,total,currency_code,metadata",
  "*items,shipping_address.phone,*payment_collections,*payment_collections.payments,*fulfillments,*fulfillments.labels",
].join(",");

/** Candidates fetched per query word; ranking and filters run locally (see search.ts). */
const SEARCH_CANDIDATES = 100;
const MAX_QUERY_WORDS = 5;
const ORDER_PAGE = 50;
const MAX_ORDER_PAGES = 10;

interface Touched {
  variantId: string;
  /** Quantity of this variant in the cart before the write; 0 = no line. */
  previous: number;
}

/**
 * CommerceProvider for Medusa v2 (ADR-006). Catalog, carts and checkout use the Store API with the publishable
 * key; order lookup uses the Admin API with the secret key. Medusa takes no idempotency keys on these endpoints,
 * so replay is the engine's job (ADR-002); keys are validated and otherwise unused.
 */
export class MedusaCommerceProvider implements CommerceProvider {
  readonly platform = "medusa";
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(CAPABILITIES);

  private readonly http: MedusaHttp;
  private readonly options: z.output<typeof MedusaProviderOptionsSchema>;
  private region: Promise<MedusaRegion> | undefined;

  constructor(options: MedusaProviderOptions) {
    this.options = parseInput(MedusaProviderOptionsSchema, options);
    this.http = new MedusaHttp({ ...this.options, fetch: options.fetch ?? fetch });
  }

  // catalog ---------------------------------------------------------------

  async searchProducts(input: SearchProductsInput): Promise<SearchProductsResult> {
    const query = parseInput(SearchProductsInputSchema, input);
    const offset = decodeCursor(query.cursor);
    if (offset === null) throw new CommerceError("INVALID_INPUT", "Invalid cursor");
    const queryWords = words(query.query ?? "").slice(0, MAX_QUERY_WORDS);
    const region = await this.regionInfo();

    const pages: Promise<MedusaProduct[]>[] = [];
    if (queryWords.length === 0) {
      pages.push(this.fetchProducts({ limit: SEARCH_CANDIDATES }));
    } else {
      for (const word of queryWords) pages.push(this.fetchProducts({ q: word, limit: SEARCH_CANDIDATES }));
      // Medusa's `q` does not search categories, so "trousers" also pulls that category's products.
      const categories = await this.categoryIds(queryWords);
      if (categories.length > 0)
        pages.push(this.fetchProducts({ category_id: categories, limit: SEARCH_CANDIDATES }));
    }
    const byId = new Map<string, Product>();
    for (const product of (await Promise.all(pages)).flat()) {
      if (byId.has(product.id)) continue;
      const mapped = this.mapProduct(product, region);
      if (mapped) byId.set(product.id, mapped);
    }
    const { items, total } = rankProducts([...byId.values()], {
      words: queryWords,
      filters: query.filters,
      offset,
      limit: query.limit,
    });
    const next = offset + items.length;
    return { items, nextCursor: next < total ? encodeCursor(next) : null };
  }

  async getProduct(productId: string): Promise<Product | null> {
    const region = await this.regionInfo();
    try {
      const { product } = await this.http.store(
        ProductResponse,
        "GET",
        `/store/products/${encodeURIComponent(productId)}`,
        {
          query: { region_id: region.id, fields: PRODUCT_FIELDS },
        },
      );
      return this.mapProduct(product, region);
    } catch (error) {
      if (error instanceof CommerceError && error.code === "NOT_FOUND") return null;
      throw error;
    }
  }

  async listProducts(input: ListProductsInput): Promise<ListProductsResult> {
    const query = parseInput(ListProductsInputSchema, input);
    const offset = decodeCursor(query.cursor);
    if (offset === null) throw new CommerceError("INVALID_INPUT", "Invalid cursor");
    const region = await this.regionInfo();
    const response = await this.http.store(ProductsResponse, "GET", "/store/products", {
      query: {
        region_id: region.id,
        fields: PRODUCT_FIELDS,
        limit: query.limit,
        offset,
        order: "id",
        "updated_at[$gte]": query.updatedSince,
      },
    });
    const next = offset + response.products.length;
    const more = response.count !== null && response.count !== undefined && next < response.count;
    return {
      items: response.products.flatMap((product) => this.mapProduct(product, region) ?? []),
      nextCursor: more ? encodeCursor(next) : null,
    };
  }

  async getInventory(variantIds: string[]): Promise<InventoryLevel[]> {
    const ids = [...new Set(parseInput(GetInventoryInputSchema, variantIds))];
    const variants = await this.fetchVariants(ids);
    return ids.flatMap((variantId) => {
      const variant = variants.get(variantId);
      return variant ? [{ variantId, ...variantStock(variant) }] : [];
    });
  }

  // carts -----------------------------------------------------------------

  async createCart(input: CreateCartInput, opts: WriteOptions): Promise<Cart> {
    const query = parseInput(CreateCartInputSchema, input);
    parseInput(WriteOptionsSchema, opts);
    const region = await this.regionInfo();
    const currency = region.currency_code.toUpperCase();
    if (query.currency !== undefined && query.currency !== currency) {
      throw new CommerceError("INVALID_INPUT", `This store sells in ${currency}`, {
        currency: query.currency,
      });
    }
    const { cart } = await this.http.store(CartResponse, "POST", "/store/carts", {
      query: { fields: CART_FIELDS },
      body: { region_id: region.id, metadata: query.attributes },
    });
    return toCart(cart);
  }

  async getCart(cartId: string): Promise<Cart | null> {
    const cart = await this.findCart(cartId);
    return cart ? toCart(cart) : null;
  }

  async addCartLines(cartId: string, input: AddCartLinesInput, opts: WriteOptions): Promise<Cart> {
    const query = parseInput(AddCartLinesInputSchema, input);
    parseInput(WriteOptionsSchema, opts);
    const cart = await this.requireOpenCart(cartId);

    const requested = new Map<string, number>();
    for (const line of query.lines)
      requested.set(line.variantId, (requested.get(line.variantId) ?? 0) + line.quantity);
    const variants = await this.fetchVariants([...requested.keys()]);
    const current = quantities(cart);
    // Check every line before writing anything, so an expected failure changes nothing.
    for (const [variantId, quantity] of requested) {
      const variant = variants.get(variantId);
      if (!variant) throw new CommerceError("NOT_FOUND", "Variant not found", { variantId });
      const total = (current.get(variantId)?.quantity ?? 0) + quantity;
      if (total > MAX_LINE_QUANTITY) {
        throw new CommerceError("INVALID_INPUT", `At most ${MAX_LINE_QUANTITY} of one item per order`, {
          variantId,
        });
      }
      assertStock(variant, total);
    }

    const touched: Touched[] = [];
    let latest = cart;
    try {
      for (const [variantId, quantity] of requested) {
        const line = current.get(variantId);
        touched.push({ variantId, previous: line?.quantity ?? 0 });
        latest = line
          ? await this.setLineQuantity(cartId, line.id, line.quantity + quantity)
          : await this.addLine(cartId, variantId, quantity);
      }
    } catch (error) {
      await this.restore(cartId, touched, error);
      throw error;
    }
    return toCart(latest);
  }

  async updateCartLine(cartId: string, input: UpdateCartLineInput, opts: WriteOptions): Promise<Cart> {
    const query = parseInput(UpdateCartLineInputSchema, input);
    parseInput(WriteOptionsSchema, opts);
    const cart = await this.requireOpenCart(cartId);
    const line = (cart.items ?? []).find((item) => item.id === query.lineId);
    if (!line) throw new CommerceError("NOT_FOUND", "Cart line not found", { lineId: query.lineId });
    if (query.quantity === 0) return toCart(await this.removeLine(cartId, line.id));
    const variant = (await this.fetchVariants([line.variant_id ?? ""])).get(line.variant_id ?? "");
    if (variant) assertStock(variant, query.quantity);
    return toCart(await this.setLineQuantity(cartId, line.id, query.quantity));
  }

  async updateCartAttributes(
    cartId: string,
    input: UpdateCartAttributesInput,
    opts: WriteOptions,
  ): Promise<Cart> {
    const query = parseInput(UpdateCartAttributesInputSchema, input);
    parseInput(WriteOptionsSchema, opts);
    const cart = await this.requireCart(cartId);
    const { cart: updated } = await this.http.store(CartResponse, "POST", cartPath(cartId), {
      query: { fields: CART_FIELDS },
      body: { metadata: { ...(cart.metadata ?? {}), ...query.attributes } },
    });
    return toCart(updated);
  }

  async createCheckout(cartId: string, opts: WriteOptions): Promise<CheckoutHandoff> {
    parseInput(WriteOptionsSchema, opts);
    await this.requireOrderableCart(cartId);
    const url = new URL("/cart/adopt", this.options.storefrontUrl);
    url.searchParams.set("cart_id", cartId);
    return { cartId, url: url.toString(), expiresAt: null };
  }

  // orders ----------------------------------------------------------------

  async lookupOrder(input: LookupOrderInput): Promise<Order | null> {
    const query = parseInput(LookupOrderInputSchema, input);
    const number = query.orderNumber.replace(/^#/, "");
    if (!/^\d+$/.test(number)) return null;
    const wanted = Number(number);
    // `q` matches loosely; ascending display_id puts the exact match before every larger number containing it.
    for (let page = 0; page < MAX_ORDER_PAGES; page += 1) {
      const { orders } = await this.http.admin(OrdersResponse, "GET", "/admin/orders", {
        query: {
          q: number,
          order: "display_id",
          limit: ORDER_PAGE,
          offset: page * ORDER_PAGE,
          fields: ORDER_FIELDS,
        },
      });
      const match = orders.find((order) => Number(order.display_id) === wanted);
      if (match) return identityMatches(query.identity, orderOwner(match)) ? toOrder(match) : null;
      const last = orders.at(-1);
      if (orders.length < ORDER_PAGE || (last && Number(last.display_id) > wanted)) return null;
    }
    return null;
  }

  async listOrders(input: ListOrdersInput): Promise<Order[]> {
    const query = parseInput(ListOrdersInputSchema, input);
    const { identity } = query;
    const searches: Record<string, string>[] = [];
    if (identity.email) searches.push({ q: identity.email });
    if (identity.phone) searches.push({ q: identity.phone });
    if (identity.externalCustomerId) searches.push({ customer_id: identity.externalCustomerId });
    const results = await Promise.all(
      searches.map((search) =>
        this.http.admin(OrdersResponse, "GET", "/admin/orders", {
          query: { ...search, order: "-created_at", limit: ORDER_PAGE, fields: ORDER_FIELDS },
        }),
      ),
    );
    const byId = new Map<string, MedusaOrder>();
    for (const { orders } of results) for (const order of orders) byId.set(order.id, order);
    return [...byId.values()]
      .filter((order) => identityMatches(identity, orderOwner(order)))
      .flatMap((order) => toOrder(order) ?? [])
      .sort((a, b) => Date.parse(b.placedAt) - Date.parse(a.placedAt))
      .slice(0, query.limit);
  }

  // cash on delivery --------------------------------------------------------

  async quoteCodOrder(cartId: string, input: CodDetailsInput): Promise<CodQuote> {
    const details = parseInput(CodDetailsSchema, input);
    await this.assertDelivers(details);
    const cart = toCart(await this.requireOrderableCart(cartId));
    const deliveryFee = (await this.cheapestDelivery(cartId)).fee;
    return {
      cartId,
      subtotal: cart.subtotal,
      deliveryFee,
      total: { amount: cart.subtotal.amount + deliveryFee.amount, currency: cart.currency },
      itemCount: cart.itemCount,
    };
  }

  /**
   * Sets the delivery details and the cheapest delivery option, pays with Medusa's manual provider and completes
   * the cart. If a step after the details fails, the details stay on the cart (its lines are unchanged).
   */
  async placeCodOrder(cartId: string, input: CodDetailsInput, opts: WriteOptions): Promise<Order> {
    const details = parseInput(CodDetailsSchema, input);
    parseInput(WriteOptionsSchema, opts);
    await this.assertDelivers(details);
    const cart = await this.requireOrderableCart(cartId);
    const address = medusaAddress(details);
    await this.http.store(CartResponse, "POST", cartPath(cartId), {
      query: { fields: CART_FIELDS },
      body: {
        ...(details.email ? { email: details.email } : {}),
        shipping_address: address,
        billing_address: address,
        metadata: { ...(cart.metadata ?? {}), ...(details.note ? { delivery_note: details.note } : {}) },
      },
    });
    const delivery = await this.cheapestDelivery(cartId);
    await this.http.store(CartResponse, "POST", `${cartPath(cartId)}/shipping-methods`, {
      query: { fields: CART_FIELDS },
      body: { option_id: delivery.id },
    });
    const { payment_collection } = await this.http.store(
      PaymentCollectionResponse,
      "POST",
      "/store/payment-collections",
      {
        body: { cart_id: cartId },
      },
    );
    await this.http.store(
      z.object({}),
      "POST",
      `/store/payment-collections/${encodeURIComponent(payment_collection.id)}/payment-sessions`,
      { body: { provider_id: COD_PROVIDER_ID } },
    );
    const completed = await this.http.store(CompleteCartResponse, "POST", `${cartPath(cartId)}/complete`);
    if (completed.type !== "order") {
      throw new CommerceError(
        "CONFLICT",
        "The store could not place the order.",
        { cartId },
        { cause: completed.error },
      );
    }
    const { order } = await this.http.admin(
      OrderResponse,
      "GET",
      `/admin/orders/${encodeURIComponent(completed.order.id)}`,
      {
        query: { fields: ORDER_FIELDS },
      },
    );
    const mapped = toOrder(order);
    if (!mapped)
      throw new CommerceError("UPSTREAM_UNAVAILABLE", "The store returned an empty order.", { cartId });
    return mapped;
  }

  // helpers ---------------------------------------------------------------

  private regionInfo(): Promise<MedusaRegion> {
    this.region ??= this.http
      .store(RegionResponse, "GET", `/store/regions/${encodeURIComponent(this.options.regionId)}`, {
        query: { fields: "id,currency_code,*countries" },
      })
      .then((response) => response.region)
      .catch((error: unknown) => {
        this.region = undefined;
        throw error;
      });
    return this.region;
  }

  private mapProduct(product: MedusaProduct, region: MedusaRegion): Product | null {
    return toProduct(product, {
      storefrontUrl: this.options.storefrontUrl,
      currency: region.currency_code.toUpperCase(),
    });
  }

  private async fetchProducts(filter: Record<string, string | number | string[]>): Promise<MedusaProduct[]> {
    const region = await this.regionInfo();
    const { products } = await this.http.store(ProductsResponse, "GET", "/store/products", {
      query: { ...filter, region_id: region.id, fields: PRODUCT_FIELDS },
    });
    return products;
  }

  private async categoryIds(queryWords: string[]): Promise<string[]> {
    const { product_categories } = await this.http.store(
      CategoriesResponse,
      "GET",
      "/store/product-categories",
      {
        query: { fields: "id,handle,name", limit: 200 },
      },
    );
    const wanted = new Set(queryWords);
    return product_categories
      .filter(
        (category) =>
          wanted.has((category.handle ?? "").toLowerCase()) || wanted.has(category.name.toLowerCase()),
      )
      .map((category) => category.id);
  }

  private async fetchVariants(ids: string[]): Promise<Map<string, MedusaVariant>> {
    const wanted = ids.filter((id) => id !== "");
    if (wanted.length === 0) return new Map();
    const { variants } = await this.http.store(VariantsResponse, "GET", "/store/product-variants", {
      query: { id: wanted, limit: wanted.length, fields: VARIANT_FIELDS },
    });
    return new Map(variants.map((variant) => [variant.id, variant]));
  }

  private async findCart(cartId: string): Promise<MedusaCart | null> {
    try {
      const { cart } = await this.http.store(CartResponse, "GET", cartPath(cartId), {
        query: { fields: CART_FIELDS },
      });
      return cart;
    } catch (error) {
      if (error instanceof CommerceError && error.code === "NOT_FOUND") return null;
      throw error;
    }
  }

  private async requireCart(cartId: string): Promise<MedusaCart> {
    const cart = await this.findCart(cartId);
    if (!cart) throw new CommerceError("NOT_FOUND", "Cart not found", { cartId });
    return cart;
  }

  private async requireOpenCart(cartId: string): Promise<MedusaCart> {
    const cart = await this.requireCart(cartId);
    if (cart.completed_at) throw new CommerceError("CONFLICT", "This cart was already ordered.", { cartId });
    return cart;
  }

  /** An open, non-empty cart whose every line can still be fulfilled. */
  private async requireOrderableCart(cartId: string): Promise<MedusaCart> {
    const cart = await this.requireOpenCart(cartId);
    const items = cart.items ?? [];
    if (items.length === 0) throw new CommerceError("CONFLICT", "The cart is empty.", { cartId });
    const variants = await this.fetchVariants(items.map((item) => item.variant_id ?? ""));
    for (const item of items) {
      const variant = variants.get(item.variant_id ?? "");
      if (!variant)
        throw new CommerceError("OUT_OF_STOCK", "An item is no longer sold.", { lineId: item.id });
      assertStock(variant, item.quantity);
    }
    return cart;
  }

  private async addLine(cartId: string, variantId: string, quantity: number): Promise<MedusaCart> {
    const { cart } = await this.http.store(CartResponse, "POST", `${cartPath(cartId)}/line-items`, {
      query: { fields: CART_FIELDS },
      body: { variant_id: variantId, quantity },
    });
    return cart;
  }

  private async setLineQuantity(cartId: string, lineId: string, quantity: number): Promise<MedusaCart> {
    const { cart } = await this.http.store(
      CartResponse,
      "POST",
      `${cartPath(cartId)}/line-items/${encodeURIComponent(lineId)}`,
      {
        query: { fields: CART_FIELDS },
        body: { quantity },
      },
    );
    return cart;
  }

  private async removeLine(cartId: string, lineId: string): Promise<MedusaCart> {
    await this.http.store(
      z.object({}),
      "DELETE",
      `${cartPath(cartId)}/line-items/${encodeURIComponent(lineId)}`,
    );
    return this.requireCart(cartId);
  }

  /**
   * Puts every variant this write touched back to its previous quantity, read fresh from the store (a timed-out
   * request may have been applied). If that fails too, the cart may be partly changed: report it as ambiguous.
   */
  private async restore(cartId: string, touched: Touched[], cause: unknown): Promise<void> {
    try {
      const now = quantities(await this.requireCart(cartId));
      for (const { variantId, previous } of [...touched].reverse()) {
        const line = now.get(variantId);
        if (!line || line.quantity === previous) continue;
        if (previous === 0) await this.removeLine(cartId, line.id);
        else await this.setLineQuantity(cartId, line.id, previous);
      }
    } catch (restoreError) {
      throw new CommerceError(
        "UPSTREAM_UNAVAILABLE",
        "The store did not confirm the change; the cart may be partly updated.",
        { cartId },
        { cause: new AggregateError([cause, restoreError]) },
      );
    }
  }

  private async assertDelivers(details: CodDetails): Promise<void> {
    const region = await this.regionInfo();
    const country = details.address.countryCode.toLowerCase();
    if (!(region.countries ?? []).some((candidate) => candidate.iso_2.toLowerCase() === country)) {
      throw new CommerceError("INVALID_INPUT", "The store does not deliver to this country.", {
        countryCode: details.address.countryCode,
      });
    }
  }

  private async cheapestDelivery(cartId: string): Promise<{ id: string; fee: ReturnType<typeof toMoney> }> {
    const region = await this.regionInfo();
    const { shipping_options } = await this.http.store(
      ShippingOptionsResponse,
      "GET",
      "/store/shipping-options",
      {
        query: { cart_id: cartId },
      },
    );
    const priced = shipping_options.flatMap((option) => {
      const amount = option.calculated_price?.calculated_amount ?? option.amount;
      return amount === null || amount === undefined ? [] : [{ id: option.id, amount }];
    });
    priced.sort((a, b) => a.amount - b.amount);
    const [cheapest] = priced;
    if (!cheapest)
      throw new CommerceError("INVALID_INPUT", "The store has no delivery option for this cart.", { cartId });
    return { id: cheapest.id, fee: toMoney(cheapest.amount, region.currency_code) };
  }
}

function cartPath(cartId: string): string {
  return `/store/carts/${encodeURIComponent(cartId)}`;
}

function quantities(cart: MedusaCart): Map<string, { id: string; quantity: number }> {
  const result = new Map<string, { id: string; quantity: number }>();
  for (const item of cart.items ?? []) {
    if (item.variant_id && !result.has(item.variant_id)) {
      result.set(item.variant_id, { id: item.id, quantity: item.quantity });
    }
  }
  return result;
}

function assertStock(variant: MedusaVariant, quantity: number): void {
  if (!variant.manage_inventory || variant.allow_backorder) return;
  const available = variantStock(variant).quantityAvailable ?? 0;
  if (quantity > available) {
    throw new CommerceError("OUT_OF_STOCK", `Only ${available} left`, { variantId: variant.id, available });
  }
}

function medusaAddress(details: CodDetails) {
  const [first = details.name, ...rest] = details.name.split(/\s+/);
  return {
    first_name: first,
    last_name: rest.join(" "),
    phone: details.phone,
    address_1: details.address.line1,
    address_2: details.address.line2 ?? "",
    city: details.address.city,
    province: details.address.district ?? "",
    postal_code: details.address.postalCode ?? "",
    country_code: details.address.countryCode.toLowerCase(),
  };
}
