import { CommerceError } from "@ace/contracts";
import { type Db, sealSecret } from "@ace/db";
import { createDemoEmbedder } from "@ace/knowledge";
import { IndexedCatalogProvider } from "@ace/search";
import { describe, expect, it, vi } from "vitest";
import { createMemoryIdempotencyStore, IdempotentCommerceProvider } from "./idempotent-provider";
import { createProviderFactory } from "./providers";

const masterKey = Buffer.alloc(32, 7);
const factory = () =>
  createProviderFactory({ idempotencyStore: () => createMemoryIdempotencyStore(), masterKey });
const store = (
  id: string,
  platform = "memory",
  credentialsSealed: Buffer | null = null,
  config: unknown = {},
) => ({ id, platform, credentialsSealed, config });
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

describe("createProviderFactory with the search index", () => {
  // Construction never touches the database; the decorator's own tests cover queries.
  const db = {} as Db;
  const logger = () => ({ warn: vi.fn(), error: vi.fn() });
  const indexFactory = (log = logger(), embedderFor = vi.fn(() => createDemoEmbedder())) => ({
    log,
    embedderFor,
    providers: createProviderFactory({
      idempotencyStore: () => createMemoryIdempotencyStore(),
      masterKey,
      index: { db, embedderFor },
      logger: log,
    }),
  });
  const indexMode = { search: { mode: "index", embeddingModel: "demo:hash-v1" } };

  it("serves index-mode stores through IndexedCatalogProvider around the idempotency layer", () => {
    const { providers, embedderFor } = indexFactory();
    const provider = providers("t1", store("s1", "memory", null, indexMode));
    expect(provider).toBeInstanceOf(IndexedCatalogProvider);
    expect(provider.platform).toBe("memory");
    expect(embedderFor).toHaveBeenCalledWith("demo:hash-v1");
    expect(providers("t1", store("s1", "memory", null, indexMode))).toBe(provider);
  });

  it("leaves live-mode and unconfigured stores unchanged", () => {
    const { providers } = indexFactory();
    expect(providers("t1", store("s1"))).toBeInstanceOf(IdempotentCommerceProvider);
    expect(providers("t1", store("s2", "memory", null, { search: { mode: "live" } }))).toBeInstanceOf(
      IdempotentCommerceProvider,
    );
    expect(providers("t1", { id: "s3", platform: "memory" })).toBeInstanceOf(IdempotentCommerceProvider);
  });

  it("rebuilds the provider when the search config changes", () => {
    const { providers } = indexFactory();
    const live = providers("t1", store("s1"));
    const indexed = providers("t1", store("s1", "memory", null, indexMode));
    expect(indexed).not.toBe(live);
    expect(
      providers(
        "t1",
        store("s1", "memory", null, { search: { ...indexMode.search, knowledgeThreshold: 0.5 } }),
      ),
    ).not.toBe(indexed);
  });

  it("refuses a bad search config with INVALID_INPUT and logs it", () => {
    const { providers, log } = indexFactory();
    expect(() => providers("t1", store("s1", "memory", null, { search: { mode: "fast" } }))).toThrow(
      expect.objectContaining({ code: "INVALID_INPUT" }),
    );
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error.mock.calls[0]?.[0]).toMatchObject({ tenantId: "t1", storeId: "s1" });
  });

  it("searches full-text only when the embedding model cannot be built", () => {
    const { providers, log } = indexFactory(
      logger(),
      vi.fn(() => {
        throw new Error("demo models are not allowed in production");
      }),
    );
    expect(providers("t1", store("s1", "memory", null, indexMode))).toBeInstanceOf(IndexedCatalogProvider);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("serves index-mode stores live when the factory has no index", () => {
    const log = logger();
    const providers = createProviderFactory({
      idempotencyStore: () => createMemoryIdempotencyStore(),
      masterKey,
      logger: log,
    });
    expect(providers("t1", store("s1", "memory", null, indexMode))).toBeInstanceOf(
      IdempotentCommerceProvider,
    );
    expect(log.warn).toHaveBeenCalledTimes(1);
  });
});
