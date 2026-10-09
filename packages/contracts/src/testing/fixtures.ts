import type { VerifiedIdentity } from "../identity";
import type { CommerceProvider } from "../provider";

/** Store data each adapter must provide so the conformance suite can run against it. */
export interface ConformanceFixtures {
  /** Query that matches at least 2 products. */
  searchTerm: string;
  /** A published product. */
  productId: string;
  /** A variant with exactly `inStockQuantity` units available. */
  inStockVariantId: string;
  /** Units available of `inStockVariantId`: 2–19, so "one more than available" is still a valid quantity. */
  inStockQuantity: number;
  /** A variant with 0 units available. */
  outOfStockVariantId: string;
  /** An existing order owned by `orderOwner`. */
  orderNumber: string;
  orderOwner: VerifiedIdentity;
  /** An identity that owns no orders. */
  stranger: VerifiedIdentity;
  /**
   * Optional test hooks into the store. Tests that need stock to change between calls are skipped without them.
   * The suite restores every quantity it changes.
   */
  control?: ConformanceControl;
}

export interface ConformanceControl {
  /** Sets the units available of a variant on the store itself (not through the provider). */
  setStock(variantId: string, quantity: number): Promise<void>;
}

export interface ConformanceSubject {
  provider: CommerceProvider;
  fixtures: ConformanceFixtures;
}

export interface ConformanceOptions {
  /**
   * Whether the provider itself replays idempotency keys (same key → first result). Default true. Adapters for
   * platforms without keys pass false and rely on the engine's IdempotentCommerceProvider (ADR-002), which runs
   * the replay tests over them.
   */
  replay?: boolean;
}
