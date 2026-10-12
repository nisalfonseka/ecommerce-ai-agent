import type { CodDetails, Money, Order } from "@ace/contracts";

/**
 * Delivery details and the quote the shopper is looking at, between the COD form and Confirm. Personal data:
 * it lives only in the conversation's session (covered by retention, export and purge) and is cleared once the
 * order is placed.
 */
export interface CodDraft {
  cartId: string;
  details: CodDetails;
  subtotal: Money;
  deliveryFee: Money;
  total: Money;
  itemCount: number;
}

/** A product the shopper has seen, addressable as "#n" in later messages. */
export interface ShownProduct {
  ref: string;
  productId: string;
  title: string;
  /** Variants that matched the search filters when shown. */
  variantIds: string[];
}

/** Per-conversation state owned by the engine and persisted between turns. */
export interface SessionState {
  shown: ShownProduct[];
  /**
   * The cart already tagged with ace_conversation_id. A cart ID, not a flag: the host site can hand over a
   * new cart mid-conversation (e.g. after a checkout), and that cart must be tagged too.
   */
  attributedCartId: string | null;
  codDraft?: CodDraft | null;
  /** The last COD order and the idempotency key that placed it, so a retried Confirm returns it again. */
  lastOrder?: { key: string; order: Order } | null;
}

export function createSession(): SessionState {
  return { shown: [], attributedCartId: null };
}

/** Replaces the shown list; refs restart at #1 so "the second one" means the latest results. */
export function rememberShown(session: SessionState, items: Omit<ShownProduct, "ref">[]): ShownProduct[] {
  session.shown = items.map((item, index) => ({ ref: `#${index + 1}`, ...item }));
  return session.shown;
}

export function resolveProductRef(session: SessionState, ref: string): ShownProduct | undefined {
  const match = /^#?(\d+)$/.exec(ref.trim());
  const digits = match?.[1];
  if (digits === undefined) return undefined;
  return session.shown.find((shown) => shown.ref === `#${Number(digits)}`);
}
