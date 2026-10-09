# Phase 5 — Reference Store and First Real Adapter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** In progress (2026-10-09). D1 = Medusa v2, D4 = no pilot client yet, so the store is built generically (ADR-006). Live evals (Phase 2 Task 10) and the VPS (Phase 3 Task 12) are on hold, so the staging exit (Task 11) waits for the owner. Everything else runs locally: Medusa 2.21.2 runs in the cloud container on the throwaway Postgres without Docker or Redis.

**Goal:** A real store behind the contract. A Medusa v2 backend and Next.js storefront for a generic Sri Lankan clothing shop, with PayHere card payments and cash on delivery. `@ace/adapter-medusa` passes the (now stricter) conformance suite. The widget runs on the storefront with real cart sync, and a shopper can place a COD order from chat after an explicit confirmation.

**Architecture:** `apps/reference-store` is a standalone npm project (ADR-006) with two parts: `backend/` (Medusa: config, seed, PayHere payment provider, order webhook subscriber) and `storefront/` (Next.js). `@ace/adapter-medusa` is a workspace package that uses `fetch` against Medusa's Store API (publishable key) and Admin API (secret key), and validates every response with Zod. The engine builds it from sealed store credentials. COD placement is a deterministic UI action confirmed by the shopper, never a model tool (ADR-007).

**Tech Stack:** Medusa 2.21.2 (`@medusajs/medusa`, `@medusajs/framework`, `@medusajs/cli`), Next.js 15 (storefront), Zod 4, Vitest, Playwright.

**Spec:** §3 G2, G5, G18; J4; §11 D1/D4. Workflow §C, §E, §F. ADR-001, ADR-002, ADR-006, ADR-007. Roadmap Phase 5.

## Global Constraints

- Phase 1–4 constraints apply.
- **The contract stays platform-free.** No Medusa types or IDs outside `packages/adapter-medusa` and `apps/reference-store`.
- **Adapters validate platform responses** with Zod and translate every platform error into a `CommerceError` (`cause` keeps the original for logs, never for the model).
- **Writes stay atomic.** Medusa adds one line per request, so a multi-line add pre-checks stock for every line and compensates (restores the previous quantities) if a later line fails.
- **Payment data never reaches the agent or the engine.** PayHere runs between the storefront, PayHere and the Medusa backend. Its signatures are verified in the backend.
- **Medusa integration tests** need a running backend: `ACE_MEDUSA_URL`, `ACE_MEDUSA_PUBLISHABLE_KEY`, `ACE_MEDUSA_SECRET_KEY`. They skip without them; the CI `medusa` job sets them and fails if they were skipped (`ACE_REQUIRE_MEDUSA_TESTS=1`).
- **No later-phase scaffolding:** no engine webhook ingress or `webhook_events` (Phase 6), no OTP verification (Phase 7). The store sends order webhooks; the engine starts consuming them in Phase 6.

## Review Focus

1. **COD confirmation.** Only a shopper's click on the summary card's Confirm button can place a COD order. The model has no tool that places orders. A replayed or forged action cannot place a second order, and COD limits are checked in code.
2. **PayHere signatures.** The checkout hash and the `notify_url` `md5sig` match PayHere's documented algorithm. An unsigned or tampered notification never marks a payment as captured.
3. **Adapter atomicity.** A multi-line add that fails on line 2 leaves line 1's previous quantity in place, including when the cart already held that variant.
4. **Attribution.** A cart tagged with `ace_conversation_id` keeps it through checkout, so the order's metadata carries it (PayHere and COD).

---

## File Structure

```text
packages/contracts/src/errors.ts, catalog.ts, datetime.ts                   # Task 1
packages/contracts/src/testing/conformance.ts, fixtures.ts                   # Task 2
packages/adapter-memory/src/memory-provider.ts, seed.ts                      # Task 2, Task 3
apps/engine/src/idempotent-provider.conformance.test.ts                      # Task 2
packages/contracts/src/cod.ts, provider.ts, capabilities.ts                  # Task 3
apps/reference-store/
  backend/ medusa-config.ts, src/scripts/seed.ts                             # Task 4
  backend/src/modules/payhere/ (hash.ts, service.ts, index.ts)               # Task 5
  backend/src/subscribers/order-placed.ts                                    # Task 5
  storefront/ (Next.js app)                                                  # Task 8
packages/adapter-medusa/src/ (client.ts, mapping.ts, errors.ts, medusa-provider.ts, conformance.test.ts)  # Task 6
apps/engine/src/providers.ts, routes/admin.ts                                # Task 7
packages/agent/src/tools/cod.ts, apps/engine/src/routes/actions.ts           # Task 9
packages/widget/src/ui/cod.tsx                                               # Task 9
scripts/reference-store.sh, .github/workflows/ci.yml                         # Task 4, Task 10
```

---

### Task 1: Contract hardening (entry gate, part 1)

- `CommerceError` takes `{ cause }` (kept for logs; adapters pass the platform error). `isCommerceError` checks a brand (`Symbol.for("ace.commerce-error")`) as well as `instanceof`, so an error from a second copy of `@ace/contracts` is still recognised.
- `ProductSchema` cross-field checks: every `variant.productId` equals the product `id`; `priceRange.min/max` equal the lowest/highest variant price; all prices share one currency.
- `toIsoDateTime(value: string | Date): string` normalises to UTC `Z` with milliseconds; adapters use it for every datetime (the schemas reject offsets).

- [x] Failing tests: error `cause` and the brand (a plain object carrying the brand passes, a lookalike without it fails); each cross-field rule; `toIsoDateTime("2026-10-09T10:15:00+05:30")` → `"2026-10-09T04:45:00.000Z"`.
- [x] Implement; checks; commit `feat(contracts): error cause and brand, product cross-field checks, UTC datetimes`.

### Task 2: Conformance suite v2 (entry gate, part 2)

New options and fixtures:
- `describeProviderConformance(name, setup, options?: { replay?: boolean })`. `replay: false` skips the idempotent-replay tests for adapters that rely on the engine (ADR-002, ADR-006).
- `ConformanceFixtures` gains `inStockQuantity` (exact units of `inStockVariantId`, 2–19) and an optional `control?: { setStock(variantId, quantity): Promise<void> }` for tests that need stock to change between calls (skipped without it; the suite restores what it changes).

New tests:
- fixture self-checks
- replay for `createCart`, `updateCartLine` and `createCheckout`
- failed-write retry: a write that failed does not hold its key, so a retry with the same key runs again
- atomicity when the cart already holds the variant
- over-stock: adding or updating above the available quantity is `OUT_OF_STOCK`
- `getInventory` omits unknown IDs
- `listOrders` is newest-first
- `createCheckout` is `OUT_OF_STOCK` when a line can no longer be fulfilled (needs `control`)
- `listProducts` `updatedSince` is inclusive
- every datetime ends in `Z`

Memory adapter parity: `MemoryCommerceProvider({ idempotency: false })` turns off its own replay map. The memory fixtures provide `control`. The engine runs the whole suite over `IdempotentCommerceProvider(new MemoryCommerceProvider({ idempotency: false }))` on Postgres, which proves the replay tests against the decorator (ADR-002).

- [x] Write the new tests; see the memory adapter fail where it lacks parity; fix the adapter; commit `test(contracts): conformance suite v2 and memory adapter parity`.

### Task 3: Contract v1.1 — cash on delivery

```ts
// capability "orders.place_cod"
quoteCodOrder(cartId: string, input: CodDetails): Promise<CodQuote>;
placeCodOrder(cartId: string, input: CodDetails, opts: WriteOptions): Promise<Order>;

CodDetails = {
  name: string;               // 1–120
  phone: string;              // Sri Lankan mobile, normalised to +94XXXXXXXXX
  email?: string;
  address: { line1: string; line2?: string; city: string; district?: string; postalCode?: string; countryCode: string };
  note?: string;              // ≤ 500
}
CodQuote = { cartId; currency; subtotal: Money; deliveryFee: Money; total: Money; itemCount }
```

- `placeCodOrder` errors: `CONFLICT` (empty cart, or the cart was already completed), `OUT_OF_STOCK`, `INVALID_INPUT`, `NOT_FOUND`. The order's `paymentStatus` is `cod_pending`. The cart's attributes (`ace_conversation_id`) carry over to the order on the store.
- Conformance: quote totals add up; place returns an order the identity `{ phone }` can look up; empty cart → `CONFLICT`; replay returns the same order (replay suite).
- Memory adapter: a flat delivery fee from the seed (LKR 400), new orders appended to its order list.

- [x] Failing tests (schema, phone normalisation, conformance); implement; commit `feat(contracts): cash-on-delivery capability (contract v1.1)`.

### Task 4: Reference store backend (Medusa)

- `apps/reference-store/backend`: `package.json` (exact Medusa versions), `medusa-config.ts` (admin dashboard on in dev and off in CI, the PayHere provider registered when its env is set, the system provider used for COD), `tsconfig.json`, `.env.template`.
- `src/scripts/seed.ts` (`npx medusa exec ./src/scripts/seed.ts`), idempotent:
  - store currency LKR; region "Sri Lanka" (`lk`), tax-inclusive prices
  - sales channel "Web", a publishable key, a secret API key for the adapter
  - stock location "Colombo warehouse"; fulfillment set "Island-wide delivery" with one flat shipping option, LKR 400
  - the same clothing catalog as the memory adapter (titles, sizes, colours, prices, stock), so evals and conformance fixtures match
  - one customer with one completed order for the order-lookup fixtures
  - it prints the keys and fixture IDs as JSON for scripts and CI
- `scripts/reference-store.sh start|stop|seed`: creates the `ace_store` database on the throwaway Postgres, runs `medusa db:migrate`, seeds, and starts the backend on :9000. Logs go outside the project, because Medusa's dev watcher restarts on file changes.
- [x] Manual check: `/health`, `/store/products` with the publishable key. Commit `feat(reference-store): Medusa backend with LKR region, clothing catalog and seed`.

### Task 5: PayHere provider and order webhooks (backend)

- `src/modules/payhere/hash.ts` (pure, unit-tested):
  - `checkoutHash({ merchantId, orderId, amount, currency, merchantSecret })` = `UPPER(md5(merchant_id + order_id + amount(2dp) + currency + UPPER(md5(secret))))`
  - `verifyNotification(fields, merchantSecret)` checks `md5sig` the same way with `status_code`. It returns `{ valid, status: "captured" | "pending" | "canceled" | "failed" | "chargedback" }`.
- `service.ts`: an `AbstractPaymentProvider` (`identifier = "payhere"`).
  - `initiatePayment` returns the checkout form fields (`merchant_id`, `order_id` = payment session ID, `amount`, `currency`, `hash`, plus return, cancel and notify URLs) as session data.
  - `getWebhookActionAndData` verifies `md5sig` and maps status `2` → `captured` and `0` → `pending`; anything else, or a bad signature, → `not_supported`.
  - `authorizePayment` reports `authorized` only after a verified notification.
- `src/subscribers/order-placed.ts`: on `order.placed`, when `ACE_ORDER_WEBHOOK_URL` is set, POST `{ id, eventId, type: "order.placed", orderId, displayId, total, currency, attributes: { ace_conversation_id } }`. It is signed `X-ACE-Signature: sha256=<hmac>` with `ACE_ORDER_WEBHOOK_SECRET`, and retried 3 times with backoff. The engine consumes it in Phase 6.
- [x] Failing tests for `hash.ts` (vectors computed from PayHere's documented formula) and the webhook signer; implement; commit `feat(reference-store): PayHere payment provider and signed order webhooks`.

**As built (Task 5).**
- Medusa's `processPaymentWorkflow` authorizes a session using only the session's stored data, so a webhook verified in `getWebhookActionAndData` cannot tell `authorizePayment` that PayHere confirmed the payment.
- Notifications therefore go to a dedicated route, `POST /payhere/notify` (`src/api/payhere/notify/route.ts`). It verifies `md5sig`, checks the amount and currency against the session, and stores an HMAC-signed `payhere_verification` (bound to session, status, payment ID, amount and currency) in the session data. On `captured` it runs `processPaymentWorkflow`, which completes the cart. Repeats are ignored.
- `authorizePayment` returns `captured` only with a valid signature for the session's current amount. `getWebhookActionAndData` is `not_supported`.
- Medusa merges shopper-supplied session data into the provider's data, so a forged verification can reach the session. The HMAC is what rejects it.
- Verified locally against Medusa:
  - completing before the notification → 400
  - forged notification → 400
  - signed notification → order created with `ace_conversation_id`
  - repeated notification → ignored
  - signed `order.placed` webhook received


### Task 6: `@ace/adapter-medusa`

- `MedusaCommerceProvider({ baseUrl, publishableKey, secretKey, regionId, salesChannelId?, storefrontUrl, fetch? })`, platform `"medusa"`, capabilities: all of v1.1.
- `client.ts`: `fetch` with a timeout (10 s), JSON, Zod-validated responses. HTTP and Medusa errors are translated:
  - 404 → `NOT_FOUND`
  - 400 `invalid_data` → `INVALID_INPUT`
  - inventory errors → `OUT_OF_STOCK`
  - 401/403 → `UNAUTHORIZED`
  - 429 → `RATE_LIMITED`
  - 5xx, network or timeout → `UPSTREAM_UNAVAILABLE`
- `mapping.ts`: Medusa product/variant/cart/order → contract types. Prices are in major units in Medusa v2, so convert to integer minor units with the currency's exponent; datetimes go through `toIsoDateTime`; availability comes from `inventory_quantity` and `manage_inventory`/`allow_backorder`; the product URL is `${storefrontUrl}/products/${handle}`.
- Search: `GET /store/products?q=&limit=&offset=` with option, price and stock filters applied to the returned page (cursor = offset).
- Cart: Store API carts. Attributes ↔ `cart.metadata`. Checkout handoff URL is `${storefrontUrl}/cart/adopt?cart_id=…` (the storefront sets its cart cookie and redirects to checkout).
- Orders: Admin API `GET /admin/orders?q=<number>` plus an ownership check against the verified email or phone; `null` for non-owners.
- COD: set email, addresses and the cheapest shipping option, create a payment collection with `pp_system_default`, complete the cart.
- `conformance.test.ts` runs `describeProviderConformance("medusa", …, { replay: false })` against a running backend, with `control.setStock` via the Admin API. Unit tests (`mapping.test.ts`, `client.test.ts`) use recorded Medusa responses and a fake `fetch`.
- [x] Failing unit tests; implement; then run conformance against the local backend; commit `feat(adapter-medusa): Medusa v2 adapter passing conformance`.

**As built (Task 6).**
- Conformance against the local Medusa: 33 passed, 6 skipped (the 5 replay tests, which belong to the engine decorator, and the not-supported probe, because every capability is declared).
- **Search.** Medusa's `q` (one call per query word, plus a category match) only collects candidates. Ranking and filters are the memory adapter's rules, applied locally to at most 100 candidates per word. The Phase 6 index replaces this for large catalogs.
- **Inventory** comes from the Store API (`+inventory_quantity`, which is stocked minus reserved), so only order lookup needs the secret key.
- **Order lookup.** The Admin API ignores `email` and `display_id` filters, so lookups use `q`. `lookupOrder` pages in ascending `display_id`, so the exact number comes first. Ownership is then checked with `identityMatches` against the order's email, shipping phone and customer ID.
- **Atomic multi-line add.**
  - Every line is pre-checked (exists, line cap, stock) before the first write.
  - If a later write still fails (a stock race or a timeout), every touched variant is set back to its previous quantity, read fresh from the store.
  - Unit tests drive both cases with a fake Medusa.
- **COD.** Sets the address and the cheapest delivery option, uses Medusa's manual provider (`pp_system_default`), then completes the cart. The order keeps the cart metadata (`ace_conversation_id`). Medusa needs no email for it.


### Task 7: Engine — Medusa stores

- `providers.ts` builds `MedusaCommerceProvider` for `platform: "medusa"` stores from the sealed credentials (`{ baseUrl, publishableKey, secretKey, regionId, storefrontUrl }`, validated with Zod).
- `POST /admin/tenants/:id/stores` accepts `platform: "medusa"` with those credentials. The response never echoes secrets.
- The engine's `IdempotentCommerceProvider` conformance run also covers Medusa when the Medusa env is set.
- [x] Failing tests; implement; commit `feat(engine): Medusa stores from sealed credentials`.

### Task 8: Storefront (Next.js)

- `apps/reference-store/storefront`: Next.js 15 (App Router) with `@medusajs/js-sdk`. Pages:
  - home/catalog
  - product (size buttons, add to cart)
  - cart
  - checkout (contact and address, then PayHere or cash on delivery)
  - order confirmation
- `/cart/adopt?cart_id=` sets the cart cookie and redirects to `/checkout`.
- The widget install snippet is in the root layout. The header cart badge listens for `ace:cart-updated`, and `ACE.setCart(cartId)` runs whenever the storefront creates a cart, so the widget and the site share one cart.
- PayHere: checkout POSTs the provider's form fields to the sandbox URL (`https://sandbox.payhere.lk/pay/checkout`), or to live when `PAYHERE_SANDBOX=false`.
- [ ] Playwright (local stack: Postgres, Medusa, engine on the Medusa adapter, storefront):
  1. add a product from a chat card
  2. the header badge updates
  3. Checkout opens the storefront checkout with the same cart
  4. pay by COD
  5. the confirmation page shows the order
  6. the order's metadata carries `ace_conversation_id` (Admin API)

  Commit `feat(reference-store): Next.js storefront with widget and shared cart`.

### Task 9: COD through chat (ADR-007)

- Agent tool `start_cod_order` (requires `orders.place_cod` and bot config `cod.enabled`). It validates the cart (non-empty, live stock) and pushes a `delivery_form` UI part. It takes no personal data from the model.
- UI action `cod_quote` (widget form → `CodDetails`, Zod-validated). It applies the COD rules from bot config (`cod.maxTotal`, optional `cod.allowedCities`), calls `quoteCodOrder`, stores the details in the session under a `codDraft` with a quote fingerprint, and returns a `cod_summary` UI part (lines, delivery fee, total, address, Confirm and Edit).
- UI action `place_cod_order` (`{ conversationId, conversationToken, actionId }`). It re-quotes; if the total changed since the summary, it returns a new summary instead of placing the order. Otherwise it calls `placeCodOrder` (idempotency key = `actionId`), clears the draft, and returns an `order` UI part. The model is told the order number on its next turn through session state.
- Widget: `DeliveryForm` (name, phone, address, city, note) and `CodSummary` cards.
- [x] Failing tests:
  - the model cannot place an order (no such tool)
  - a confirm without a draft is rejected
  - a confirm after a total change returns a new summary
  - a double click places one order
  - `maxTotal` and cities are enforced
  - the form renders text safely
- [x] Implement; commit `feat: cash-on-delivery orders confirmed by the shopper`.

**As built (Task 9).**
- `ACTION_TOOLS` (`cod_quote`, `place_cod_order`) are runnable only through engine UI actions; `buildTools` never sees them.
- COD policy is set in `storeFacts.cod` (`enabled`, `maxTotal` in minor units, `allowedCities`, `countryCode`, default LK).
- The engine's session schema accepts `codDraft` and `lastOrder`.
- Tool-call records and action summaries show "(delivery details)" instead of the shopper's details.
- New eval case `en-cod`. Live evals are still on hold (no API keys).

### Task 10: CI and docs

- [x] CI job `medusa`: Postgres service, `npm ci` in `apps/reference-store/backend`, migrate, seed, start, then the adapter conformance (`ACE_REQUIRE_MEDUSA_TESTS=1`) and the engine replay run. Nightly schedule for the same job.
- [ ] Docs:
  - AGENTS.md: status, commands, plan link
  - `docs/workflow.md` §E (as built, ADR-007) and §F
  - ADR-007

### Task 11: Staging exit (owner-gated)

- [ ] Deploy the reference store next to the engine on the VPS (needs Phase 3 Task 12) with PayHere sandbox credentials from the owner.
- [ ] Exit: a shopper completes a PayHere sandbox payment and a COD order through chat; both orders carry `ace_conversation_id`.

## Phase 5 exit checklist

- [ ] Conformance v2 passes for memory (direct and through the engine decorator) and Medusa.
- [ ] Local e2e: chat card → shared cart → storefront checkout → COD order with attribution.
- [ ] COD through chat places exactly one order, only after Confirm.
- [ ] `pnpm lint && pnpm typecheck && pnpm test` green; CI `medusa` and `e2e` green.
- [ ] Staging exit (Task 11), when the owner unblocks staging.
