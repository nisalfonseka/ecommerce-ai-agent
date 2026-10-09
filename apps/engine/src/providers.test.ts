import { describe, expect, it } from "vitest";
import { createMemoryIdempotencyStore, IdempotentCommerceProvider } from "./idempotent-provider";
import { createProviderFactory } from "./providers";

const factory = () => createProviderFactory({ idempotencyStore: () => createMemoryIdempotencyStore() });
const store = (id: string, platform = "memory") => ({ id, platform });

describe("createProviderFactory", () => {
  it("wraps the memory adapter in the idempotency layer and caches one instance per tenant and store", () => {
    const providers = factory();
    const a = providers("t1", store("s1"));
    expect(a).toBeInstanceOf(IdempotentCommerceProvider);
    expect(providers("t1", store("s1"))).toBe(a);
    expect(providers("t2", store("s1"))).not.toBe(a);
  });

  it("refuses platforms without an adapter", () => {
    expect(() => factory()("t1", store("s1", "shopify"))).toThrow(/shopify/);
  });
});
