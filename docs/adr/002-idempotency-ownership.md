# ADR-002: Idempotency ownership

- Status: Accepted (2026-10-08). Implementation: Phase 3.

## Context

`addCartLines` is relative: replaying it adds the quantities again. Medusa v2 store line-item endpoints and Shopify
Storefront `cartLinesAdd` accept no idempotency key. An adapter-local in-memory map cannot survive restarts, multiple
engine processes, or a lost response after the platform applied the write. The memory adapter's map exists only so the
conformance suite can test replay semantics.

## Decision

- The engine owns idempotency through an `IdempotentCommerceProvider` decorator, backed by Postgres and keyed by
  (tenant, store, operation, target, key).
- It stores a fingerprint of the input and the result. A replay with the same fingerprint returns the stored result. A
  different fingerprint gets `CONFLICT`.
- On an ambiguous failure (timeout or network error after sending), it re-reads the cart through `getCart` and
  reconciles, instead of blindly retrying the write.
- Absolute operations (`updateCartLine` with an absolute quantity) are preferred for retries.
- Adapters forward keys where the platform supports them.
- The conformance replay test is run against decorator-wrapped adapters from Phase 3 on.

## Consequences

- Phase 3 adds an `idempotency_records` table and the decorator.
- Phase 2 tools generate keys as `turnId:toolCallId`.
