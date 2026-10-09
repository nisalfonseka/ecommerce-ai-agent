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
  attributionTagged: boolean;
}

export function createSession(): SessionState {
  return { shown: [], attributionTagged: false };
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
