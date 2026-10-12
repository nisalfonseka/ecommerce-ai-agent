# ADR-008: Search read model and `IndexedCatalogProvider`

- Status: Accepted (2026-10-09). Implementation: Phase 6 Tasks 5–7 (`packages/search`).
- Owner decisions recorded here: S1 (embedding model), S2 (no per-search LLM rewrite).

## Context

Store-native search (Phase 2–5) is keyword-only, ignores Singlish, Sinhala and Tamil, and cannot use the attributes
enrichment adds (occasion, fabric, fit). Phase 6 adds a search read model in Postgres (`catalog_products`,
`catalog_variants`, `catalog_sync_state`), kept current by webhooks and reconciliation (ADR-009). The read model is
always somewhat stale, and AGENTS.md rule 3 says live data is authoritative.

## Decision

### The index chooses candidates; live data decides

`IndexedCatalogProvider` is a decorator that implements `CommerceProvider` and delegates every method except
`searchProducts`. The contract does not change and no capability is added. For a search it:

1. Validates the input (`parseInput`, so bad input is `INVALID_INPUT` as for any adapter).
2. Rewrites the query with the lexicon (`normalizeQuery`) and embeds it (`purpose: "query"`).
3. Runs `hybridSearch` over the read model for `limit × 2` candidates (over-fetch for step 4).
4. Calls `inner.getProduct` for the candidates in rank order (at most 5 at a time) and recomputes the matching
   variants on the **live** product with the same variant filters (options case-insensitive, price, stock).
   Products the store no longer returns, or with no live variant left, are dropped. Summaries are built with
   `summarizeProduct(live, matching)`, so every price, availability and variant id comes from this call.

The engine wraps `IdempotentCommerceProvider` with the decorator, so the idempotency layer stays innermost and writes
are unchanged. Stores opt in with `stores.config.search.mode = "index"` (default `"live"`).

### Hybrid search

- One "eligible" CTE: `store_id = $store`, `status = 'active'`, `NOT hidden`, category (store category or effective
  `attributes.category`), and a lateral aggregate over variants that pass the option (`option_keys &&`, any value
  within a name, every name required), price and stock filters. The aggregate gives `matchingVariantIds`. Every
  statement filters on the store as well as the RLS tenant, so two stores of one tenant never see each other.
- Full-text leg: `websearch_to_tsquery('english', text)` OR-ed with `to_tsquery('simple', 'w1' | 'w2' …)`, so an
  unknown Singlish word does not empty the result; ranked by `ts_rank_cd`, top 50.
- Vector leg: only rows whose `embedding_model` equals the embedder's model (vectors from different models are not
  comparable), ordered by cosine distance, top 50.
- Fusion: `score = Σ 1/(60 + rank)`, halved when every matching variant is out of stock (by the index), plus
  `0.01 × boost`. Ties break by product id. Without query text (filters only): `boost desc`, availability, title.
- The cursor is `{ offset, q }` where `q` is 12 hex chars of sha256 over the query and filters. A cursor reused with
  another query or other filters is `INVALID_INPUT`.

### S1: embeddings are 768-dimensional, with the model recorded per row

Default `google:gemini-embedding-001` with `outputDimensionality: 768`; `openai:text-embedding-3-small` with
`dimensions: 768` is the alternative. Every column is `vector(768)`. Each row stores `embedding_model` and
`embedded_hash`; a row from another model counts as not embedded and is re-embedded by `embed.product`, which
skips rows whose hash and model already match. Claude has no embedding model, so a store on Claude still needs a
Google or OpenAI key for embeddings. `demo:*` models (keyless, deterministic, lexical) are refused in production.

### S2: a lexicon instead of a per-search LLM rewrite (deviation from spec §4.4 step 1)

The spec planned a cheap-model call to normalise every query. We do not make it: the agent model already turns the
shopper's words into structured `search_products` input, so a second call would add ~300–800 ms and one paid call
per search for little gain. `@ace/search` adds a small, reviewed lexicon (Singlish, Sinhala and Tamil → catalog
English; every target is a `VOCAB` value) applied deterministically, and the vector leg handles paraphrase. The
tokenizer keeps U+200D (ZWJ) inside words so Sinhala conjuncts match. If the relevance eval (Task 8) misses its
target on non-English queries, the fallback is an LLM rewrite behind `search.normalize: "llm"`.

### Exact vector search, no ANN index

The vector leg is an exact scan. Per-store catalogs are small (hundreds to a few thousand products), and the scan
already runs inside the tenant and store filters. An HNSW index is built over the whole table: a filtered HNSW scan
returns its `ef_search` nearest neighbours across all tenants and then filters, so it loses recall for any one
store. Revisit with partitioning or per-store partial indexes if a store grows past ~50k products.

### Fallbacks

- Sync state not ready (never fully synced, or the last run failed) → `inner.searchProducts`. An incremental sync in
  progress after a completed full sync keeps the index in use.
- No query text and no filters other than `inStockOnly` → `inner.searchProducts` (browsing is the store's job).
- Embedder throws, or none is configured → full-text only, reported through `onError` (logged by the engine).
- A live `getProduct` fails for some candidates → those are skipped and reported. All of them fail → the first
  error is thrown (an outage must not look like "nothing found").
- Live re-checks drop candidates → up to three candidate pages are read to fill the requested limit.
- A bad `config.search` → `INVALID_INPUT` when the provider is built (logged); the admin API refuses it at creation.

## Consequences

- Search latency adds one embedding call and up to `limit` live `getProduct` calls (5 in parallel).
- Results can never show a stale price or a sold-out variant as available, whatever the index says.
- Ranking quality depends on enrichment and embeddings; the relevance eval (Task 8) guards it in CI.
