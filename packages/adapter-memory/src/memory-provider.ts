import {
  type AddCartLinesInput,
  AddCartLinesInputSchema,
  type Availability,
  addMoney,
  CAPABILITIES,
  type Capability,
  type Cart,
  type CartLine,
  type CheckoutHandoff,
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
  money,
  multiplyMoney,
  type Order,
  type Product,
  parseInput,
  type SearchProductsInput,
  type SearchProductsResult,
  type UpdateCartAttributesInput,
  UpdateCartAttributesInputSchema,
  type UpdateCartLineInput,
  UpdateCartLineInputSchema,
  type Variant,
  type WriteOptions,
  WriteOptionsSchema,
} from "@ace/contracts";
import { decodeCursor, encodeCursor } from "./cursor";
import { searchCatalog } from "./search";
import { defaultSeed, type MemorySeed } from "./seed";

export const LOW_STOCK_THRESHOLD = 2;

export function availabilityFor(quantity: number): Availability {
  if (quantity <= 0) return "out_of_stock";
  if (quantity <= LOW_STOCK_THRESHOLD) return "low_stock";
  return "in_stock";
}

export interface MemoryProviderOptions {
  seed?: MemorySeed;
  now?: () => Date;
  checkoutBaseUrl?: string;
  /**
   * Replay writes by idempotency key inside the adapter (default true). The engine passes false when it wraps the
   * adapter in IdempotentCommerceProvider, so its replay tests exercise the decorator, not this map (ADR-002).
   */
  idempotency?: boolean;
}

interface StoredLine {
  id: string;
  variantId: string;
  quantity: number;
}

interface StoredCart {
  id: string;
  currency: string;
  attributes: Record<string, string>;
  lines: StoredLine[];
  updatedAt: string;
  /** Set when the cart became an order; a completed cart takes no more lines and cannot be ordered again. */
  completedAt?: string;
}

export class MemoryCommerceProvider implements CommerceProvider {
  readonly platform = "memory";
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(CAPABILITIES);

  protected readonly seed: MemorySeed;
  protected readonly now: () => Date;
  protected readonly checkoutBaseUrl: string;
  private readonly carts = new Map<string, StoredCart>();
  private readonly idempotentResults = new Map<string, unknown>();
  private readonly replayWrites: boolean;
  private nextId = 1;

  constructor(options: MemoryProviderOptions = {}) {
    this.seed = structuredClone(options.seed ?? defaultSeed());
    this.now = options.now ?? (() => new Date());
    this.checkoutBaseUrl = options.checkoutBaseUrl ?? "https://demo-store.test/checkout";
    this.replayWrites = options.idempotency ?? true;
  }

  /** Test hook (conformance `control`): sets the units available of a variant. */
  setStock(variantId: string, quantity: number): void {
    this.requireVariant(variantId);
    this.seed.stock[variantId] = quantity;
  }

  // catalog ---------------------------------------------------------------

  async searchProducts(input: SearchProductsInput): Promise<SearchProductsResult> {
    return searchCatalog(this.liveProducts(), input);
  }

  async getProduct(productId: string): Promise<Product | null> {
    const product = this.seed.products.find((candidate) => candidate.id === productId);
    return product ? this.withLiveAvailability(product) : null;
  }

  async listProducts(input: ListProductsInput): Promise<ListProductsResult> {
    const query = parseInput(ListProductsInputSchema, input);
    const offset = decodeCursor(query.cursor);
    const since = query.updatedSince ? Date.parse(query.updatedSince) : Number.NEGATIVE_INFINITY;
    const matching = this.liveProducts()
      .filter((product) => Date.parse(product.updatedAt) >= since)
      .sort((a, b) => a.id.localeCompare(b.id));
    const page = matching.slice(offset, offset + query.limit);
    const nextOffset = offset + page.length;
    return { items: page, nextCursor: nextOffset < matching.length ? encodeCursor(nextOffset) : null };
  }

  async getInventory(variantIds: string[]): Promise<InventoryLevel[]> {
    const ids = parseInput(GetInventoryInputSchema, variantIds);
    return [...new Set(ids)].flatMap((variantId) => {
      const quantity = this.seed.stock[variantId];
      if (quantity === undefined) return [];
      return [{ variantId, availability: availabilityFor(quantity), quantityAvailable: quantity }];
    });
  }

  // cart + checkout -------------------------------------------------------

  async createCart(input: CreateCartInput, opts: WriteOptions): Promise<Cart> {
    return this.once("createCart", "-", opts, () => {
      const query = parseInput(CreateCartInputSchema, input);
      const currency = query.currency ?? this.seed.currency;
      if (currency !== this.seed.currency) {
        throw new CommerceError("INVALID_INPUT", `This store sells in ${this.seed.currency}`, { currency });
      }
      const cart: StoredCart = {
        id: this.newId("cart"),
        currency,
        attributes: query.attributes,
        lines: [],
        updatedAt: this.now().toISOString(),
      };
      this.carts.set(cart.id, cart);
      return this.toCart(cart);
    });
  }

  async getCart(cartId: string): Promise<Cart | null> {
    const cart = this.carts.get(cartId);
    return cart ? this.toCart(cart) : null;
  }

  async addCartLines(cartId: string, input: AddCartLinesInput, opts: WriteOptions): Promise<Cart> {
    return this.once("addCartLines", cartId, opts, () => {
      const query = parseInput(AddCartLinesInputSchema, input);
      const cart = this.requireOpenCart(cartId);
      const next = cart.lines.map((line) => ({ ...line }));
      for (const { variantId, quantity } of query.lines) {
        const { variant } = this.requireVariant(variantId);
        const existing = next.find((line) => line.variantId === variantId);
        const total = (existing?.quantity ?? 0) + quantity;
        if (total > MAX_LINE_QUANTITY) {
          throw new CommerceError("INVALID_INPUT", `At most ${MAX_LINE_QUANTITY} of one item per order`, {
            variantId,
          });
        }
        this.assertInStock(variant, total);
        if (existing) existing.quantity = total;
        else next.push({ id: this.newId("line"), variantId, quantity });
      }
      cart.lines = next;
      cart.updatedAt = this.now().toISOString();
      return this.toCart(cart);
    });
  }

  async updateCartLine(cartId: string, input: UpdateCartLineInput, opts: WriteOptions): Promise<Cart> {
    return this.once("updateCartLine", cartId, opts, () => {
      const query = parseInput(UpdateCartLineInputSchema, input);
      const cart = this.requireOpenCart(cartId);
      const line = cart.lines.find((candidate) => candidate.id === query.lineId);
      if (!line) throw new CommerceError("NOT_FOUND", "Cart line not found", { lineId: query.lineId });
      if (query.quantity === 0) {
        cart.lines = cart.lines.filter((candidate) => candidate.id !== query.lineId);
      } else {
        this.assertInStock(this.requireVariant(line.variantId).variant, query.quantity);
        line.quantity = query.quantity;
      }
      cart.updatedAt = this.now().toISOString();
      return this.toCart(cart);
    });
  }

  async updateCartAttributes(
    cartId: string,
    input: UpdateCartAttributesInput,
    opts: WriteOptions,
  ): Promise<Cart> {
    return this.once("updateCartAttributes", cartId, opts, () => {
      const query = parseInput(UpdateCartAttributesInputSchema, input);
      const cart = this.requireCart(cartId);
      cart.attributes = { ...cart.attributes, ...query.attributes };
      cart.updatedAt = this.now().toISOString();
      return this.toCart(cart);
    });
  }

  async createCheckout(cartId: string, opts: WriteOptions): Promise<CheckoutHandoff> {
    return this.once("createCheckout", cartId, opts, () => {
      this.requireOrderableCart(cartId);
      return { cartId, url: `${this.checkoutBaseUrl}/${encodeURIComponent(cartId)}`, expiresAt: null };
    });
  }

  // orders ----------------------------------------------------------------

  async lookupOrder(input: LookupOrderInput): Promise<Order | null> {
    const query = parseInput(LookupOrderInputSchema, input);
    const wanted = query.orderNumber.toLowerCase();
    const match = this.seed.orders.find((entry) => entry.order.number.toLowerCase() === wanted);
    if (!match || !identityMatches(query.identity, match.owner)) return null;
    return structuredClone(match.order);
  }

  async listOrders(input: ListOrdersInput): Promise<Order[]> {
    const query = parseInput(ListOrdersInputSchema, input);
    return this.seed.orders
      .filter((entry) => identityMatches(query.identity, entry.owner))
      .map((entry) => structuredClone(entry.order))
      .sort((a, b) => b.placedAt.localeCompare(a.placedAt))
      .slice(0, query.limit);
  }

  // cash on delivery --------------------------------------------------------

  async quoteCodOrder(cartId: string, input: CodDetailsInput): Promise<CodQuote> {
    const details = parseInput(CodDetailsSchema, input);
    this.assertDelivers(details.address.countryCode);
    return this.quote(this.requireOrderableCart(cartId));
  }

  async placeCodOrder(cartId: string, input: CodDetailsInput, opts: WriteOptions): Promise<Order> {
    return this.once("placeCodOrder", cartId, opts, () => {
      const details = parseInput(CodDetailsSchema, input);
      this.assertDelivers(details.address.countryCode);
      const stored = this.requireOrderableCart(cartId);
      const quote = this.quote(stored);
      const cart = this.toCart(stored);
      for (const line of stored.lines) {
        this.seed.stock[line.variantId] = (this.seed.stock[line.variantId] ?? 0) - line.quantity;
      }
      const placedAt = this.now().toISOString();
      const order: Order = {
        id: this.newId("ord"),
        number: `ACE-${2000 + this.seed.orders.length}`,
        status: "pending",
        paymentStatus: "cod_pending",
        placedAt,
        total: quote.total,
        lines: cart.lines.map((line) => ({
          title: line.title,
          variantTitle: line.variantTitle,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
        })),
        tracking: [],
      };
      this.seed.orders.push({ order, owner: { email: details.email, phone: details.phone } });
      stored.completedAt = placedAt;
      stored.updatedAt = placedAt;
      return structuredClone(order);
    });
  }

  // helpers ---------------------------------------------------------------

  private quote(cart: StoredCart): CodQuote {
    const { subtotal, itemCount } = this.toCart(cart);
    const deliveryFee = { ...this.seed.delivery.fee };
    return { cartId: cart.id, subtotal, deliveryFee, total: addMoney(subtotal, deliveryFee), itemCount };
  }

  private assertDelivers(countryCode: string): void {
    if (!this.seed.delivery.countries.includes(countryCode)) {
      throw new CommerceError("INVALID_INPUT", "The store does not deliver to this country.", {
        countryCode,
      });
    }
  }

  private requireOpenCart(cartId: string): StoredCart {
    const cart = this.requireCart(cartId);
    if (cart.completedAt) throw new CommerceError("CONFLICT", "This cart was already ordered.", { cartId });
    return cart;
  }

  /** An open, non-empty cart whose every line can still be fulfilled. */
  private requireOrderableCart(cartId: string): StoredCart {
    const cart = this.requireOpenCart(cartId);
    if (cart.lines.length === 0) throw new CommerceError("CONFLICT", "The cart is empty.", { cartId });
    for (const line of cart.lines) {
      this.assertInStock(this.requireVariant(line.variantId).variant, line.quantity);
    }
    return cart;
  }

  protected liveProducts(): Product[] {
    return this.seed.products.map((product) => this.withLiveAvailability(product));
  }

  protected withLiveAvailability(product: Product): Product {
    const copy = structuredClone(product);
    for (const variant of copy.variants) {
      variant.availability = availabilityFor(this.seed.stock[variant.id] ?? 0);
    }
    return copy;
  }

  /** Runs a write once per (operation, target, key); replays return a copy of the first result. */
  private once<T>(operation: string, target: string, opts: WriteOptions, write: () => T): T {
    const { idempotencyKey } = parseInput(WriteOptionsSchema, opts);
    if (!this.replayWrites) return write();
    const storageKey = `${operation}:${target}:${idempotencyKey}`;
    if (this.idempotentResults.has(storageKey)) {
      return structuredClone(this.idempotentResults.get(storageKey)) as T;
    }
    const result = write();
    this.idempotentResults.set(storageKey, structuredClone(result));
    return result;
  }

  private newId(prefix: string): string {
    const id = `${prefix}_${this.nextId}`;
    this.nextId += 1;
    return id;
  }

  private requireCart(cartId: string): StoredCart {
    const cart = this.carts.get(cartId);
    if (!cart) throw new CommerceError("NOT_FOUND", "Cart not found", { cartId });
    return cart;
  }

  private requireVariant(variantId: string): { product: Product; variant: Variant } {
    for (const product of this.seed.products) {
      const variant = product.variants.find((candidate) => candidate.id === variantId);
      if (variant) return { product, variant };
    }
    throw new CommerceError("NOT_FOUND", "Variant not found", { variantId });
  }

  private assertInStock(variant: Variant, quantity: number): void {
    const available = this.seed.stock[variant.id] ?? 0;
    if (quantity > available) {
      throw new CommerceError("OUT_OF_STOCK", `Only ${available} left of ${variant.title}`, {
        variantId: variant.id,
        available,
      });
    }
  }

  private toCart(cart: StoredCart): Cart {
    const lines: CartLine[] = cart.lines.map((line) => {
      const { product, variant } = this.requireVariant(line.variantId);
      const image = product.images[0];
      return {
        id: line.id,
        productId: product.id,
        variantId: variant.id,
        title: product.title,
        variantTitle: variant.title,
        quantity: line.quantity,
        unitPrice: { ...variant.price },
        lineTotal: multiplyMoney(variant.price, line.quantity),
        image: image ? { ...image } : undefined,
      };
    });
    return {
      id: cart.id,
      currency: cart.currency,
      lines,
      subtotal: lines.reduce((sum, line) => addMoney(sum, line.lineTotal), money(0, cart.currency)),
      itemCount: lines.reduce((count, line) => count + line.quantity, 0),
      attributes: { ...cart.attributes },
      updatedAt: cart.updatedAt,
    };
  }
}
