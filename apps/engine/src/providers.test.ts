import { CommerceError } from "@ace/contracts";
import { sealSecret } from "@ace/db";
import { describe, expect, it } from "vitest";
import { createMemoryIdempotencyStore, IdempotentCommerceProvider } from "./idempotent-provider";
import { createProviderFactory } from "./providers";

const masterKey = Buffer.alloc(32, 7);
const factory = () =>
  createProviderFactory({ idempotencyStore: () => createMemoryIdempotencyStore(), masterKey });
const store = (id: string, platform = "memory", credentialsSealed: Buffer | null = null) => ({
  id,
  platform,
  credentialsSealed,
});
const medusaCredentials = {
  baseUrl: "https://store-api.example.lk",
  publishableKey: "pk_123",
  secretKey: "sk_123",
  regionId: "reg_1",
  storefrontUrl: "https://shop.example.lk",
};

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

  it("builds a Medusa store from its sealed credentials, behind the idempotency layer", () => {
    const sealed = sealSecret(JSON.stringify(medusaCredentials), masterKey);
    const provider = factory()("t1", store("s1", "medusa", sealed));
    expect(provider).toBeInstanceOf(IdempotentCommerceProvider);
    expect(provider.platform).toBe("medusa");
    expect(provider.capabilities.has("orders.place_cod")).toBe(true);
  });

  it("rebuilds the adapter when the credentials change", () => {
    const providers = factory();
    const first = providers(
      "t1",
      store("s1", "medusa", sealSecret(JSON.stringify(medusaCredentials), masterKey)),
    );
    const rotated = sealSecret(JSON.stringify({ ...medusaCredentials, secretKey: "sk_456" }), masterKey);
    expect(providers("t1", store("s1", "medusa", rotated))).not.toBe(first);
  });

  it("refuses a Medusa store with missing or invalid credentials, without echoing them", () => {
    const providers = factory();
    expect(() => providers("t1", store("s1", "medusa"))).toThrow(CommerceError);
    const bad = sealSecret(JSON.stringify({ ...medusaCredentials, baseUrl: "not a url" }), masterKey);
    try {
      providers("t1", store("s1", "medusa", bad));
      expect.unreachable();
    } catch (error) {
      expect(error).toMatchObject({ code: "UNAUTHORIZED" });
      expect(JSON.stringify(error)).not.toContain("sk_123");
      expect(String((error as Error).message)).not.toContain("sk_123");
    }
  });
});
