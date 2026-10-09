import { createHash } from "node:crypto";
import { MedusaCommerceProvider, MedusaProviderOptionsSchema } from "@ace/adapter-medusa";
import { MemoryCommerceProvider } from "@ace/adapter-memory";
import { CommerceError, type CommerceProvider } from "@ace/contracts";
import { type IdempotencyStore, openSecret } from "@ace/db";
import { IdempotentCommerceProvider } from "./idempotent-provider";

export interface StoreForProvider {
  id: string;
  platform: string;
  credentialsSealed?: Buffer | null;
}

export type ProviderFactory = (tenantId: string, store: StoreForProvider) => CommerceProvider;

/** The credentials an admin registers for a Medusa store (sealed JSON). Timeouts stay engine defaults. */
export const MedusaCredentialsSchema = MedusaProviderOptionsSchema.omit({ timeoutMs: true });

function medusaAdapter(store: StoreForProvider, masterKey: Buffer): CommerceProvider {
  const invalid = () =>
    new CommerceError("UNAUTHORIZED", "The store's credentials are missing or invalid.", {
      storeId: store.id,
    });
  if (!store.credentialsSealed) throw invalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(openSecret(store.credentialsSealed, masterKey));
  } catch {
    throw invalid();
  }
  // Never put the parse error in the thrown error: its issues can quote the secret values.
  const credentials = MedusaCredentialsSchema.safeParse(parsed);
  if (!credentials.success) throw invalid();
  return new MedusaCommerceProvider(credentials.data);
}

/**
 * store.platform → adapter, wrapped by the engine's idempotency layer (ADR-002). Instances are cached per
 * (tenant, store, credentials); the key includes the tenant so nothing is shared across tenants (AGENTS.md
 * rule 13), and a hash of the sealed credentials so a rotation takes effect without a restart.
 */
export function createProviderFactory(deps: {
  idempotencyStore: (tenantId: string) => IdempotencyStore;
  masterKey: Buffer;
}): ProviderFactory {
  const cache = new Map<string, CommerceProvider>();
  return (tenantId, store) => {
    const credentialsHash = store.credentialsSealed
      ? createHash("sha256").update(store.credentialsSealed).digest("hex").slice(0, 16)
      : "-";
    const cacheKey = `${tenantId}:${store.id}:${credentialsHash}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;
    let adapter: CommerceProvider;
    if (store.platform === "memory") adapter = new MemoryCommerceProvider();
    else if (store.platform === "medusa") adapter = medusaAdapter(store, deps.masterKey);
    else {
      throw new CommerceError("NOT_SUPPORTED", `No adapter for platform ${store.platform}`, {
        platform: store.platform,
      });
    }
    const provider = new IdempotentCommerceProvider(adapter, deps.idempotencyStore(tenantId), {
      storeId: store.id,
    });
    cache.set(cacheKey, provider);
    return provider;
  };
}
