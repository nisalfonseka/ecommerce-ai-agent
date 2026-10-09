import { createHash } from "node:crypto";
import { MedusaCommerceProvider, MedusaProviderOptionsSchema } from "@ace/adapter-medusa";
import { MemoryCommerceProvider } from "@ace/adapter-memory";
import { CommerceError, type CommerceProvider } from "@ace/contracts";
import { type Db, type IdempotencyStore, openSecret } from "@ace/db";
import type { Embedder } from "@ace/knowledge";
import { IndexedCatalogProvider, parseStoreSearchConfig, type StoreSearchConfig } from "@ace/search";
import { IdempotentCommerceProvider } from "./idempotent-provider";

export interface StoreForProvider {
  id: string;
  platform: string;
  credentialsSealed?: Buffer | null;
  /** stores.config; `search` selects live or indexed search (StoreSearchConfigSchema). */
  config?: unknown;
}

/** What the factory needs to serve index-mode stores. Optional: without it every store searches live. */
export interface SearchIndexDeps {
  db: Db;
  /** Store config model spec → embedder; may throw (unknown provider, demo model in production). */
  embedderFor(spec: string): Embedder;
}

/** Structural subset of the pino logger, so the factory does not depend on the engine's logger. */
export interface FactoryLogger {
  warn(obj: object, msg: string): void;
  error(obj: object, msg: string): void;
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

const shortHash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex").slice(0, 16);

/**
 * The search decorator goes outside the idempotency layer: writes keep their replay guarantees, and only
 * searchProducts changes. Returns the idempotent provider unchanged for live-mode stores.
 */
function withSearch(
  provider: CommerceProvider,
  tenantId: string,
  storeId: string,
  search: StoreSearchConfig,
  index: SearchIndexDeps | undefined,
  logger: FactoryLogger | undefined,
): CommerceProvider {
  if (search.mode !== "index") return provider;
  if (!index) {
    logger?.warn({ tenantId, storeId }, "search index not configured; searching the store live");
    return provider;
  }
  let embedder: Embedder | null = null;
  try {
    embedder = index.embedderFor(search.embeddingModel);
  } catch (error) {
    logger?.warn(
      { err: error, tenantId, storeId, model: search.embeddingModel },
      "embedding model unavailable; indexed search uses full-text only",
    );
  }
  return new IndexedCatalogProvider(provider, {
    db: index.db,
    tenantId,
    storeId,
    embedder,
    onError: (error) => logger?.warn({ err: error, tenantId, storeId }, "indexed search degraded"),
  });
}

/**
 * store.platform → adapter, wrapped by the engine's idempotency layer (ADR-002), then by IndexedCatalogProvider
 * when `config.search.mode` is "index" (ADR-008). Instances are cached per (tenant, store, credentials, search
 * config); the key includes the tenant so nothing is shared across tenants (AGENTS.md rule 13), and hashes of
 * the sealed credentials and the search config so a rotation or config change takes effect without a restart.
 * A bad search config throws INVALID_INPUT (and is logged).
 */
export function createProviderFactory(deps: {
  idempotencyStore: (tenantId: string) => IdempotencyStore;
  masterKey: Buffer;
  index?: SearchIndexDeps;
  logger?: FactoryLogger;
}): ProviderFactory {
  const cache = new Map<string, CommerceProvider>();
  return (tenantId, store) => {
    let search: StoreSearchConfig;
    try {
      search = parseStoreSearchConfig(store.config);
    } catch (error) {
      deps.logger?.error({ err: error, tenantId, storeId: store.id }, "invalid store search config");
      throw error;
    }
    const credentialsHash = store.credentialsSealed ? shortHash(store.credentialsSealed) : "-";
    const cacheKey = `${tenantId}:${store.id}:${credentialsHash}:${shortHash(JSON.stringify(search))}`;
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
    const idempotent = new IdempotentCommerceProvider(adapter, deps.idempotencyStore(tenantId), {
      storeId: store.id,
    });
    const provider = withSearch(idempotent, tenantId, store.id, search, deps.index, deps.logger);
    cache.set(cacheKey, provider);
    return provider;
  };
}
