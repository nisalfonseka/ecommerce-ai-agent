# ADR-006: Reference store on Medusa v2

- Status: Accepted (2026-10-09). Answers spec §11 **D1** and **D4**. Implementation: Phase 5.

## Context

Phase 5 needs a real store behind the contract: a backend with carts, inventory, orders, regions and payments, a
storefront the widget is installed on, and the first real adapter. Spec J4 recommended building it on Medusa v2
instead of writing a commerce backend from scratch. D4 asked whether a pilot client is confirmed, because their
languages, delivery regions and COD share shape the store.

## Decision

- **D1: Medusa v2** (2.21.x) is the reference store backend, with our own Next.js storefront. `@ace/adapter-medusa`
  talks to Medusa's HTTP APIs only (AGENTS.md rule 2) and is reusable for every future store we build on Medusa.
- **D4: no pilot client is confirmed yet.** The reference store is built generically for the primary market (spec
  A1): region "Sri Lanka" in **LKR**, storefront copy in English with Sinhala and Tamil handled by the assistant,
  **PayHere** card payments and **cash on delivery**, island-wide delivery with one flat fee. Everything client-specific
  (catalog, delivery zones, COD limits, fees) is seed data or tenant config, so a pilot client changes data, not code.
- **Separate toolchain.** `apps/reference-store` is a standalone npm project (its own `package-lock.json`), excluded
  from the pnpm workspace and Turborepo. Medusa brings ~1,000 packages (~700 MB), a CommonJS/SWC toolchain and its own
  CLI; keeping it out of the workspace keeps `pnpm install`, `pnpm test` and the engine image unaffected. Nothing in the
  workspace imports from it (it is an app). A dedicated CI job installs it and runs the Medusa conformance suite.
- **Medusa runs without Redis** in development and CI (in-memory event bus, cache and locking). Production uses the
  same Postgres server as the engine, in a separate database. Adding Redis for Medusa in production needs a measured
  reason (AGENTS.md rule 15).
- **Credentials.** The adapter uses a publishable key (Store API: catalog, carts, checkout) and a secret API key (Admin
  API: inventory counts, order lookup by verified identity). Both are store credentials, envelope-encrypted in `stores`.
- **Idempotency** stays with the engine (ADR-002): Medusa's store endpoints take no idempotency key. The adapter's
  conformance run uses the suite's `replay: false` option; the engine runs the replay tests over
  `IdempotentCommerceProvider`.

## Consequences

- Staging for the Phase 5 exit (PayHere sandbox payment and COD order through chat) waits for the VPS (Phase 3 Task 12)
  and PayHere sandbox merchant credentials, both owner-gated.
- When a pilot client is confirmed, revisit: their catalog import, delivery zones and fees, COD limits, and whether the
  storefront needs Sinhala/Tamil copy.
- Medusa upgrades are pinned and deliberate (exact versions in `apps/reference-store/package.json`); the nightly
  conformance run catches API drift.
