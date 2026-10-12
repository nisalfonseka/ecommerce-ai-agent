# ADR-009: Jobs and signed webhooks

- Status: Accepted (2026-10-09). Implementation: Phase 6 Tasks 2 and 3.

## Context

Stores tell the engine about changes (product, stock, order). The engine must accept those calls quickly, reject forgeries and replays, and do the heavy work (sync, enrichment, embeddings, attribution) outside the request. Infrastructure stays Postgres-only (AGENTS.md rule 15), so the queue is pg-boss.

## Decision

### ACE webhook v1

- `POST /webhooks/:storeId`, outside `/v1` (callers are stores, not widgets: no widget key, no CORS).
- Headers: `x-ace-timestamp` (unix seconds) and `x-ace-signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>`.
- **Why the timestamp is signed.** A signature over the body alone can be captured and replayed forever. Signing the timestamp and accepting only +/- 300 s bounds a replay to five minutes, and the event-id dedupe below makes a replay inside that window harmless. The store signs every retry with a fresh timestamp.
- Comparison is constant-time, with a length guard (`timingSafeEqual` throws on unequal lengths).
- The secret is per store (`stores.webhook_secret_sealed`, envelope-encrypted like other store secrets). The admin endpoint `POST /admin/tenants/:tenantId/stores/:storeId/webhook-secret` generates 32 random bytes, returns them once, and rotating replaces the old secret at once.
- The body is capped at 65,536 bytes, enforced while reading, not only from `Content-Length`.
- Unknown store, non-UUID id and "no secret yet" all answer the same 404, so callers learn nothing about which stores exist. Signature failures log the store id only.
- Body shape: Zod discriminated union on `type` (`product.updated`, `product.deleted`, `inventory.updated`, `order.placed`). Product events carry ids only; the engine re-reads the product live (AGENTS.md rule 3). The order event carries the order id/number, total and the attribution attribute, no shopper data.
- Platforms with their own webhook formats (Shopify, Phase 9) add their own verifier and translator in front of the same handler.

### Dedupe with `enqueued_at`, not one transaction

The handler records the event in `webhook_events` (unique per tenant, store and event id), then enqueues, then sets `enqueued_at`. It does not enqueue inside the database transaction, because pg-boss uses its own connection and a two-system commit is not atomic anyway. Instead:

- A redelivery with `enqueued_at` set answers `200 {duplicate: true}` and enqueues nothing.
- If the enqueue fails, the handler answers 503 and `enqueued_at` stays null, so the store's retry takes the enqueue path again. The worst case is a job enqueued twice (crash between enqueue and marking), and every job is idempotent.
- Product events are never marked processed: `enqueued_at` is the dedupe signal and the sync job is an idempotent upsert. Only `order.placed` sets `processed_at` (by the worker, after attribution).
- Product events for one product are sent with `debounceKey = "<storeId>:<productId>"` and a 5 s window, so a burst becomes one sync.

### pg-boss ownership and roles

- The `pgboss` schema is created and migrated only by the owner connection (`installJobSchema`), which also creates the queues and grants the app role DML, sequence and function privileges. The app role cannot alter the queue structure; pg-boss runs with `migrate: false`.
- The **producer** (engine) enqueues only: small pool, no supervision, no cron. The **worker** (Phase 6) consumes, supervises and schedules.

### Definer functions for pre-tenant reads

Routing a webhook needs the tenant before a tenant context exists. `resolve_webhook_store(storeId)` is a `SECURITY DEFINER` function owned by the non-bypass role `ace_router`, with column-level SELECT on `stores` and a read policy for that role only. It returns the tenant id and the sealed secret and nothing else (ADR-005). Everything after it runs in `withTenant`.

## Consequences

- A forged, replayed or duplicate webhook never enqueues work; a valid one is acknowledged after one routing read, one insert and one enqueue.
- Operators must run `installJobSchema` (owner) before the engine starts, and give each store a secret before its platform can send webhooks.
- Secret rotation is immediate: the platform must be updated first or events get 401 until it is.
