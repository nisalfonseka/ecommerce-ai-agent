# ADR-001: Universal commerce contract

- Status: Accepted (2026-10-08)
- Context: The agent must work with any store platform (own reference store, Shopify, WooCommerce, custom APIs)
  without code changes. See design spec §3.2 J1 and §4.2.

## Decision

The agent depends only on `CommerceProvider` from `@ace/contracts`:

- One provider instance per connected store; credentials bound at construction.
- Capabilities declare what an adapter supports; the agent registers only matching tools.
- Money is integer minor units + ISO 4217 code.
- Every expected failure is a typed `CommerceError` (`NOT_FOUND`, `INVALID_INPUT`, `OUT_OF_STOCK`, `NOT_SUPPORTED`,
  `UNAUTHORIZED`, `CONFLICT`, `RATE_LIMITED`, `UPSTREAM_UNAVAILABLE`).
- Writes take an idempotency key and are atomic.
- Order access requires a server-verified `VerifiedIdentity`; lookups return `null` for non-owners.
- Checkout is a URL handoff; the agent never handles payment data.
- Vocabulary follows the Universal Commerce Protocol's catalog / cart / checkout concepts, so UCP-based adapters stay
  thin.
- Every adapter must pass `describeProviderConformance` from `@ace/contracts/testing`.

## Consequences

- Adding a platform = writing one adapter package plus running the conformance suite.
- Contract changes are versioned. Additive changes add a capability; breaking changes need a new ADR.
