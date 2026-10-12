import type { Capability } from "./capabilities";
import type {
  AddCartLinesInput,
  Cart,
  CreateCartInput,
  UpdateCartAttributesInput,
  UpdateCartLineInput,
  WriteOptions,
} from "./cart";
import type {
  ListProductsInput,
  ListProductsResult,
  Product,
  SearchProductsInput,
  SearchProductsResult,
} from "./catalog";
import type { CheckoutHandoff } from "./checkout";
import type { CodDetailsInput, CodQuote } from "./cod";
import type { InventoryLevel } from "./inventory";
import type { ListOrdersInput, LookupOrderInput, Order } from "./orders";

/**
 * The only way the agent talks to a store. One instance per connected store; credentials are bound
 * when the adapter is constructed, so no method takes a tenant or store ID.
 *
 * Rules for implementers (enforced by describeProviderConformance):
 * - Validate every input with parseInput(schema, value) → CommerceError("INVALID_INPUT").
 * - Throw CommerceError for every expected failure; translate platform errors, never leak them.
 * - Methods whose capability is not declared throw CommerceError("NOT_SUPPORTED").
 * - Writes accept opts.idempotencyKey. Per ADR-002 the engine's idempotency layer guarantees replay
 *   safety (same key → first result, even if the cart changed since; same key with different input →
 *   CONFLICT). Adapters must forward the key to the platform when it supports one, and must never
 *   fail because of it.
 * - Writes are atomic: when a write throws, nothing changed. The one exception is UPSTREAM_UNAVAILABLE: a
 *   timeout may hide a write the platform applied, so the engine treats it as ambiguous and reconciles (ADR-002).
 * - Money is integer minor units.
 */
export interface CommerceProvider {
  /** Lowercase platform id: "memory", "medusa", "shopify", … */
  readonly platform: string;
  readonly capabilities: ReadonlySet<Capability>;

  /**
   * catalog.search
   * Summary availability/priceRange describe the matching variants only.
   */
  searchProducts(input: SearchProductsInput): Promise<SearchProductsResult>;
  /** catalog.read — null when the product does not exist or is not published. */
  getProduct(productId: string): Promise<Product | null>;
  /** catalog.list — stable order for sync; `updatedSince` is inclusive. */
  listProducts(input: ListProductsInput): Promise<ListProductsResult>;
  /** inventory.read — unknown variant IDs are omitted from the result. */
  getInventory(variantIds: string[]): Promise<InventoryLevel[]>;

  /** cart.write */
  createCart(input: CreateCartInput, opts: WriteOptions): Promise<Cart>;
  /** cart.write — null when the cart does not exist. */
  getCart(cartId: string): Promise<Cart | null>;
  /**
   * cart.write — merges lines for the same variant. NOT_FOUND (cart/variant), OUT_OF_STOCK, INVALID_INPUT,
   * CONFLICT (the cart was already completed as an order).
   */
  addCartLines(cartId: string, input: AddCartLinesInput, opts: WriteOptions): Promise<Cart>;
  /** cart.write — quantity 0 removes the line. */
  updateCartLine(cartId: string, input: UpdateCartLineInput, opts: WriteOptions): Promise<Cart>;
  /**
   * cart.write — merges attributes into the cart (e.g. tag the host site's cart with ace_conversation_id).
   * NOT_FOUND (cart), INVALID_INPUT.
   */
  updateCartAttributes(cartId: string, input: UpdateCartAttributesInput, opts: WriteOptions): Promise<Cart>;

  /** checkout.handoff — CONFLICT for an empty cart; OUT_OF_STOCK if a line can no longer be fulfilled. */
  createCheckout(cartId: string, opts: WriteOptions): Promise<CheckoutHandoff>;

  /** orders.lookup — null when the order does not exist OR is not owned by input.identity. */
  lookupOrder(input: LookupOrderInput): Promise<Order | null>;
  /** orders.lookup — newest first, only orders owned by input.identity. */
  listOrders(input: ListOrdersInput): Promise<Order[]>;

  /**
   * orders.place_cod — the totals the shopper confirms, delivery fee included. Read-only.
   * NOT_FOUND (cart), CONFLICT (empty or completed cart), INVALID_INPUT (details, or no delivery to the address).
   */
  quoteCodOrder(cartId: string, input: CodDetailsInput): Promise<CodQuote>;
  /**
   * orders.place_cod — places a cash-on-delivery order for the cart and completes the cart. Only after the
   * shopper confirmed the quote (ADR-007). The order's paymentStatus is "cod_pending", it is owned by the
   * details' phone (and email, if given), and the cart's attributes carry over to it on the store.
   * NOT_FOUND, CONFLICT (empty or completed cart), OUT_OF_STOCK, INVALID_INPUT.
   */
  placeCodOrder(cartId: string, input: CodDetailsInput, opts: WriteOptions): Promise<Order>;
}
