import { MemoryCommerceProvider } from "@ace/adapter-memory";
import { CommerceError, type CommerceProvider } from "@ace/contracts";
import type { IdempotencyStore } from "@ace/db";
import { IdempotentCommerceProvider } from "./idempotent-provider";

export type ProviderFactory = (tenantId: string, store: { id: string; platform: string }) => CommerceProvider;

/**
 * store.platform → adapter, wrapped by the engine's idempotency layer (ADR-002). Instances are cached per
 * (tenant, store); the key includes the tenant so nothing is shared across tenants (AGENTS.md rule 13).
 * Only the in-memory demo adapter exists until Phase 5.
 */
export function createProviderFactory(deps: {
  idempotencyStore: (tenantId: string) => IdempotencyStore;
}): ProviderFactory {
  const cache = new Map<string, CommerceProvider>();
  return (tenantId, store) => {
    const cacheKey = `${tenantId}:${store.id}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    if (store.platform !== "memory") {
      throw new CommerceError("NOT_SUPPORTED", `No adapter for platform ${store.platform}`, {
        platform: store.platform,
      });
    }
    const provider = new IdempotentCommerceProvider(
      new MemoryCommerceProvider(),
      deps.idempotencyStore(tenantId),
      {
        storeId: store.id,
      },
    );
    cache.set(cacheKey, provider);
    return provider;
  };
}
