import { createHash } from "node:crypto";
import {
  type AddCartLinesInput,
  type Cart,
  type CheckoutHandoff,
  CommerceError,
  type CommerceProvider,
  type CreateCartInput,
  isCommerceError,
  type UpdateCartAttributesInput,
  type UpdateCartLineInput,
  type WriteOptions,
} from "@ace/contracts";
import type { IdempotencyRecord, IdempotencyScope, IdempotencyStore } from "@ace/db";

/** A record still "in_progress" after this long belongs to a crashed request; treat it as ambiguous. */
const STALE_IN_PROGRESS_MS = 2 * 60_000;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, item]) => `${JSON.stringify(k)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

interface AddReconcile {
  before: Record<string, number>;
  requested: Record<string, number>;
}

function quantities(cart: Cart | null): Record<string, number> {
  const result: Record<string, number> = {};
  for (const line of cart?.lines ?? [])
    result[line.variantId] = (result[line.variantId] ?? 0) + line.quantity;
  return result;
}

/**
 * ADR-002: the engine owns idempotency. Same key + same input → the first result; same key + other input →
 * CONFLICT. A write that fails with a CommerceError changed nothing (contract), so its record is dropped. Any
 * other failure may have been applied: it is recorded as ambiguous and reconciled on replay. addCartLines is
 * relative, so it is checked against the live cart; the other writes are absolute and simply run again.
 */
export class IdempotentCommerceProvider implements CommerceProvider {
  readonly platform: string;
  readonly capabilities: CommerceProvider["capabilities"];

  constructor(
    private readonly inner: CommerceProvider,
    private readonly store: IdempotencyStore,
    private readonly options: { storeId: string; now?: () => number },
  ) {
    this.platform = inner.platform;
    this.capabilities = inner.capabilities;
  }

  searchProducts: CommerceProvider["searchProducts"] = (input) => this.inner.searchProducts(input);
  getProduct: CommerceProvider["getProduct"] = (id) => this.inner.getProduct(id);
  listProducts: CommerceProvider["listProducts"] = (input) => this.inner.listProducts(input);
  getInventory: CommerceProvider["getInventory"] = (ids) => this.inner.getInventory(ids);
  getCart: CommerceProvider["getCart"] = (id) => this.inner.getCart(id);
  lookupOrder: CommerceProvider["lookupOrder"] = (input) => this.inner.lookupOrder(input);
  listOrders: CommerceProvider["listOrders"] = (input) => this.inner.listOrders(input);

  createCart(input: CreateCartInput, opts: WriteOptions): Promise<Cart> {
    return this.once("createCart", "-", input, opts, () => this.inner.createCart(input, opts));
  }

  updateCartLine(cartId: string, input: UpdateCartLineInput, opts: WriteOptions): Promise<Cart> {
    return this.once("updateCartLine", cartId, input, opts, () =>
      this.inner.updateCartLine(cartId, input, opts),
    );
  }

  updateCartAttributes(cartId: string, input: UpdateCartAttributesInput, opts: WriteOptions): Promise<Cart> {
    return this.once("updateCartAttributes", cartId, input, opts, () =>
      this.inner.updateCartAttributes(cartId, input, opts),
    );
  }

  createCheckout(cartId: string, opts: WriteOptions): Promise<CheckoutHandoff> {
    return this.once("createCheckout", cartId, {}, opts, () => this.inner.createCheckout(cartId, opts));
  }

  async addCartLines(cartId: string, input: AddCartLinesInput, opts: WriteOptions): Promise<Cart> {
    const requested: Record<string, number> = {};
    for (const line of input.lines)
      requested[line.variantId] = (requested[line.variantId] ?? 0) + line.quantity;
    return this.once(
      "addCartLines",
      cartId,
      input,
      opts,
      () => this.inner.addCartLines(cartId, input, opts),
      {
        snapshot: async (): Promise<AddReconcile> => ({
          before: quantities(await this.inner.getCart(cartId)),
          requested,
        }),
        applied: async (reconcile) => {
          const { before, requested: wanted } = reconcile as AddReconcile;
          const cart = await this.inner.getCart(cartId);
          const now = quantities(cart);
          const done = Object.entries(wanted).every(
            ([variantId, qty]) => (now[variantId] ?? 0) >= (before[variantId] ?? 0) + qty,
          );
          return done ? cart : null;
        },
      },
    );
  }

  private async once<T>(
    operation: string,
    target: string,
    input: unknown,
    opts: WriteOptions,
    write: () => Promise<T>,
    reconcile?: { snapshot: () => Promise<unknown>; applied: (snapshot: unknown) => Promise<T | null> },
  ): Promise<T> {
    const scope: IdempotencyScope = {
      storeId: this.options.storeId,
      operation,
      target,
      key: opts.idempotencyKey,
    };
    const fingerprint = createHash("sha256")
      .update(canonicalJson({ operation, target, input }))
      .digest("hex");
    const existing = await this.store.begin(scope, fingerprint);

    if (existing !== "new") {
      if (existing.fingerprint !== fingerprint) {
        throw new CommerceError(
          "CONFLICT",
          "This idempotency key was already used for a different request.",
          {
            operation,
          },
        );
      }
      if (existing.status === "completed") return structuredClone(existing.result) as T;
      if (existing.status === "in_progress" && !this.isStale(existing)) {
        throw new CommerceError("CONFLICT", "This request is still being processed.", { operation });
      }
      if (reconcile && existing.reconcile !== null && existing.reconcile !== undefined) {
        const applied = await reconcile.applied(existing.reconcile);
        if (applied !== null) {
          await this.store.complete(scope, applied);
          return applied;
        }
      }
    }

    const snapshot = reconcile ? await reconcile.snapshot() : null;
    try {
      const result = await write();
      await this.store.complete(scope, result);
      return result;
    } catch (error) {
      if (isCommerceError(error)) {
        await this.store.remove(scope);
        throw error;
      }
      await this.store.markAmbiguous(scope, snapshot);
      throw new CommerceError(
        "UPSTREAM_UNAVAILABLE",
        "The store did not confirm the change; retry with the same key.",
        {
          operation,
        },
      );
    }
  }

  private isStale(record: IdempotencyRecord): boolean {
    const now = this.options.now?.() ?? Date.now();
    return now - record.updatedAt.getTime() > STALE_IN_PROGRESS_MS;
  }
}

/** In-process store for unit tests and the scripted demo; the engine uses createPgIdempotencyStore. */
export function createMemoryIdempotencyStore(): IdempotencyStore {
  const records = new Map<string, IdempotencyRecord>();
  const id = (s: IdempotencyScope) => JSON.stringify([s.storeId, s.operation, s.target, s.key]);
  return {
    async begin(scope, fingerprint) {
      const existing = records.get(id(scope));
      if (existing) return structuredClone(existing);
      records.set(id(scope), {
        status: "in_progress",
        fingerprint,
        result: null,
        reconcile: null,
        updatedAt: new Date(),
      });
      return "new";
    },
    async complete(scope, result) {
      const record = records.get(id(scope));
      if (record)
        Object.assign(record, {
          status: "completed",
          result: structuredClone(result),
          updatedAt: new Date(),
        });
    },
    async markAmbiguous(scope, reconcile) {
      const record = records.get(id(scope));
      if (record) Object.assign(record, { status: "ambiguous", reconcile, updatedAt: new Date() });
    },
    async remove(scope) {
      records.delete(id(scope));
    },
  };
}
