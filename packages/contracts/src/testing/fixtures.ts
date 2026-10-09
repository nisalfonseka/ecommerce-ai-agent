import type { VerifiedIdentity } from "../identity";
import type { CommerceProvider } from "../provider";

/** Store data each adapter must provide so the conformance suite can run against it. */
export interface ConformanceFixtures {
  /** Query that matches at least 2 products. */
  searchTerm: string;
  /** A published product. */
  productId: string;
  /** A variant with at least 2 units available. */
  inStockVariantId: string;
  /** A variant with 0 units available. */
  outOfStockVariantId: string;
  /** An existing order owned by `orderOwner`. */
  orderNumber: string;
  orderOwner: VerifiedIdentity;
  /** An identity that owns no orders. */
  stranger: VerifiedIdentity;
}

export interface ConformanceSubject {
  provider: CommerceProvider;
  fixtures: ConformanceFixtures;
}
