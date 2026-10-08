import {
  type AddCartLinesInput,
  type Availability,
  type Capability,
  type Cart,
  type CheckoutHandoff,
  CommerceError,
  type CommerceProvider,
  type CreateCartInput,
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
  type Order,
  type Product,
  parseInput,
  type SearchProductsInput,
  type SearchProductsResult,
  type UpdateCartLineInput,
  type WriteOptions,
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
}

const READ_CAPABILITIES: Capability[] = [
  "catalog.search",
  "catalog.read",
  "catalog.list",
  "inventory.read",
  "orders.lookup",
];

const notYet = (operation: string) => new CommerceError("NOT_SUPPORTED", `memory provider: ${operation}`);

export class MemoryCommerceProvider implements CommerceProvider {
  readonly platform = "memory";
  readonly capabilities: ReadonlySet<Capability> = new Set<Capability>(READ_CAPABILITIES);

  protected readonly seed: MemorySeed;
  protected readonly now: () => Date;
  protected readonly checkoutBaseUrl: string;

  constructor(options: MemoryProviderOptions = {}) {
    this.seed = structuredClone(options.seed ?? defaultSeed());
    this.now = options.now ?? (() => new Date());
    this.checkoutBaseUrl = options.checkoutBaseUrl ?? "https://demo-store.test/checkout";
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
    return ids.flatMap((variantId) => {
      const quantity = this.seed.stock[variantId];
      if (quantity === undefined) return [];
      return [{ variantId, availability: availabilityFor(quantity), quantityAvailable: quantity }];
    });
  }

  // cart + checkout (Task 8) ----------------------------------------------

  async createCart(_input: CreateCartInput, _opts: WriteOptions): Promise<Cart> {
    throw notYet("createCart");
  }

  async getCart(_cartId: string): Promise<Cart | null> {
    throw notYet("getCart");
  }

  async addCartLines(_cartId: string, _input: AddCartLinesInput, _opts: WriteOptions): Promise<Cart> {
    throw notYet("addCartLines");
  }

  async updateCartLine(_cartId: string, _input: UpdateCartLineInput, _opts: WriteOptions): Promise<Cart> {
    throw notYet("updateCartLine");
  }

  async createCheckout(_cartId: string, _opts: WriteOptions): Promise<CheckoutHandoff> {
    throw notYet("createCheckout");
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

  // helpers ---------------------------------------------------------------

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
}
