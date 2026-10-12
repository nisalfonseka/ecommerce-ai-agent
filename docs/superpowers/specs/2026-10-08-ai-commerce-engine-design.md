# AI Commerce Engine (ACE) — Design Spec

- **Date:** 2026-10-08
- **Status:** Draft for review
- **Source idea:** "One reusable AI Commerce Engine + per-platform adapters" (original brief, pasted by the owner)
- **Companion docs:** [`AGENTS.md`](../../../AGENTS.md) · [`docs/workflow.md`](../../workflow.md) · [Roadmap](../plans/2026-10-08-roadmap.md) · [Phase 1 plan](../plans/2026-10-08-phase-1-foundation.md)

---

## 1. Summary

ACE is a multi-tenant AI sales and support assistant for online stores. Each merchant (tenant) connects a store through a
**platform adapter**. The AI agent only knows a **universal commerce contract** (search, product, inventory, cart,
checkout handoff, order lookup), never a specific platform. The first deployment is our own clothing reference store;
later tenants plug in Shopify, WooCommerce or a custom API without changing the agent.

The original brief is sound in its core idea: put the agent behind a contract, use adapters, prefer live APIs over RAG
for prices and stock, and hand off to checkout instead of taking payment. This spec keeps all of that. It adds the parts
the brief leaves out (identity, cart sync, safety, evals, cost, privacy, localisation and operations) and corrects a few
choices that would cause trouble later.

### Goals (v1 = pilot with first client)

1. A shopper on the reference store's website can find products in natural language (English, Sinhala, Tamil, Singlish),
   get size and fit help, add the right variant to **the same cart the website uses**, and reach checkout
   (PayHere card payment or Cash on Delivery).
2. A shopper can ask policy and delivery questions and get answers grounded in the merchant's documents, with sources.
3. A verified shopper can ask "where is my order?" and get live status.
4. When the agent cannot help, it hands the conversation to a human on the merchant's side.
5. The same engine runs a second tenant on a different platform with **zero agent code changes** (proved in Phase 9).

### Non-goals (v1)

- The agent charging cards or storing payment data.
- Refunds, discounts or order edits performed by the agent.
- Self-serve merchant signup and billing (we onboard tenants by hand in v1).
- Voice, Instagram, and outbound marketing campaigns.

---

## 2. Assumptions (correct me if any are wrong)

| # | Assumption | Why it matters |
|---|---|---|
| A1 | Primary market is **Sri Lanka**, prices in **LKR** ("Rs." in the brief). Currency stays configurable per store. | Payments (PayHere, COD), language (Sinhala/Tamil/Singlish), law (PDPA). |
| A2 | The owner is a TypeScript / Next.js / Node developer and is building this mostly solo, with AI coding agents. | Stack choice; the plan favours fewer moving parts. |
| A3 | The first client is a clothing store and does not have a store yet. | We build the reference store; its adapter is the first one. |
| A4 | **Decided 2026-10-08:** hosting is a **VPS** (Docker Compose), not Vercel or serverless. | Long-running Node processes (engine, worker); we run Postgres, TLS, backups and monitoring ourselves. No platform-specific runtime APIs. |
| A5 | The first pilot target is roughly ≤ 5,000 conversations / month / tenant. | Postgres-only infrastructure is enough; no Redis in v1. |

---

## 3. Gap analysis: what is missing or should change in the original brief

### 3.1 Missing pieces (added by this spec)

| # | Gap | Risk if ignored | Resolution | Phase |
|---|---|---|---|---|
| G1 | **Shopper identity and authorization.** `getOrder(orderId)` and `getCustomerOrders(customerId)` take IDs from the LLM. | Anyone can type an order number and read another person's address and items (data leak). | Order tools never take a customer ID from the model. A server-side `ToolContext` carries a `VerifiedIdentity` (host-site session token, or email/phone OTP). `lookupOrder` returns `null` unless the order belongs to that identity. | 1 (contract), 7 |
| G2 | **Cart sync with the storefront.** The brief's agent creates its own cart. | The shopper's chat cart and website cart diverge, so items "disappear" at checkout. | The widget receives the host site's cart ID. The agent writes into that cart, and the widget emits a `ace:cart-updated` event so the site refreshes its cart badge. | 4, 5 |
| G3 | **Conversation state for references** ("I'll take the second one in large"). | The model guesses which product "the second one" is. | Session state keeps the ordered list of last-shown products and variants. Tools accept `resultRef` (`#2`) and resolve it server-side. | 2 |
| G4 | **Human handoff.** | Angry or complex cases loop with the bot; the merchant loses sales. | `request_human` tool plus automatic triggers (repeated failure, negative sentiment, explicit ask). A minimal merchant inbox shows the conversation; the merchant can be notified on WhatsApp/email. | 7 |
| G5 | **Guardrails against prompt injection and over-reach** (OWASP LLM01, LLM06). Product descriptions, reviews and uploaded documents are untrusted text the model reads. | Injected text makes the bot promise discounts, reveal the system prompt, or call tools the shopper should not. | Least-privilege tools (no refunds/discounts in v1). Tool outputs are wrapped as data. Business rules are enforced in code, not in the prompt. A confirmation step (AI SDK `toolApproval` with a server-bound approval secret) is required before any order-placing action (COD). Output checks on prices and links. | 2, 3 |
| G6 | **Hallucinated prices, stock or links.** | Legal and trust problems ("the bot said Rs. 5,000"). | The UI renders product cards, prices and the checkout link **from tool results**, not from model text. The system prompt forbids stating prices not present in tool output, and an output validator flags any currency amount that is not in the turn's tool results. | 2, 4 |
| G7 | **Evaluations and regression tests for the agent.** | Every prompt or model change can silently break selling flows. | A golden-conversation eval suite runs against the in-memory adapter in CI: tool-call correctness, grounding, refusals, language. Real (anonymised) transcripts are added after the pilot. | 2 onward |
| G8 | **Observability and cost control.** | There is no way to debug a bad answer or stop a tenant burning the LLM budget. | Per-turn traces (model, tokens, tool calls, latency), a per-tenant usage ledger, monthly budget caps with graceful degradation, and per-visitor rate limits. | 3 |
| G9 | **Catalog data quality.** Clothing catalogs rarely have clean `color`, `occasion`, `fabric` or `fit` fields. | Hybrid search filters have nothing to filter on, so search quality is poor. | An enrichment pipeline uses a small model to extract normalized attributes from title, description and images into the read model. The merchant can review and override them. | 6 |
| G10 | **Ownership of the search index.** The brief has both "search via adapter" and "own hybrid index". | Unclear source of truth; stale prices. | **Live data is authoritative.** The platform keeps a per-tenant *read model* only for discovery (search, recommendations). Before showing a price as final, adding to cart, or handing off to checkout, the agent re-reads live data through the adapter. The index is a decorator (`IndexedCatalogProvider`) around the adapter, so the contract does not change. | 6 |
| G11 | **Webhook reliability.** | Missed or duplicated webhooks leave the index stale or double-processed. | Verify signatures, dedupe by event ID, process idempotently, and run a scheduled **reconciliation** (full or incremental resync) because webhooks can be lost. | 6 |
| G12 | **Localisation.** | Sri Lankan shoppers mix Sinhala, Tamil, English and romanized Sinhala ("Singlish"); keyword search fails on that. | The agent replies in the shopper's language. A query-normalisation step rewrites the shopper's words into catalog vocabulary (English attribute values) before search. LKR formatting and local sizes are handled. Evals cover each language. | 2, 6 |
| G13 | **Privacy law.** Sri Lanka's PDPA (Act No. 9 of 2022) core obligations commence **1 January 2027** (lawful processing; controller/processor duties; breach notification; DPIAs). | A pilot that launches in early 2027 must comply on day one. | We are the **processor**, the merchant is the **controller**. Add a data-processing agreement template, a consent notice in the widget, PII redaction in logs and traces, retention limits, a deletion/export endpoint, and LLM providers configured for zero/limited data retention. | 3, 7 |
| G14 | **Attribution / ROI.** | Without proof that chat drives sales, the product cannot be sold to the next merchant. | Every agent-touched cart gets attribute `ace_conversation_id`. Order webhooks join orders back to conversations. Core KPI: chat-assisted revenue. | 1 (contract), 5, 8 |
| G15 | **Abuse of a public endpoint.** | Bots spam the widget and run up LLM cost. | Per-tenant publishable widget key + allowed-origins list, per-visitor/IP rate limits, message length caps, optional bot challenge on suspicious traffic. | 3 |
| G16 | **Failure behaviour.** | Platform API down means the bot invents answers or errors out. | Typed `CommerceError` codes (`UPSTREAM_UNAVAILABLE`, `RATE_LIMITED`, …) with `retryable`. The agent is told what failed and answers honestly ("I can't check stock right now"), and offers handoff. | 1, 2 |
| G17 | **Merchant onboarding workflow.** | Each client is a bespoke project again. | A defined onboarding runbook (see `docs/workflow.md` §A): connect store → sync → enrich → upload policies → configure persona → test in sandbox → install widget → go live. It is scripted in v1 and becomes a dashboard later. | 8 |
| G18 | **Payment reality in Sri Lanka.** Cash on Delivery is a large share of orders; card goes through local gateways (e.g., PayHere: HTML-form checkout, server-to-server `notify_url`, MD5 hash verification). | A "checkout link only" design ignores COD shoppers. | Two endings: (a) **checkout handoff** link (card / any method the store supports), (b) **COD order placement** by the agent, only after an explicit, server-verified confirmation from the shopper. | 5 |
| G19 | **WhatsApp economics.** From 1 Oct 2026 Meta bills service messages per message, marketing templates are always billed, and outbound needs opt-in plus templates outside the 24-hour window. | Unit economics and follow-up features break if designed web-first. | WhatsApp is a later channel behind a `Channel` interface; usage is metered per tenant; follow-ups require recorded opt-in. | 10 |
| G20 | **Industry protocols for agentic commerce.** Since the brief, Google + Shopify launched the **Universal Commerce Protocol (UCP)** (Jan 2026; catalog / cart / checkout capabilities, `continue_url` handoff, idempotency keys). Shopify's Storefront MCP now implements UCP Catalog. WooCommerce ships an MCP / Abilities API (developer preview). OpenAI/Stripe's **ACP** covers agent checkout with delegated payment tokens. | Inventing a vocabulary that diverges from UCP makes every future adapter a translation project. | Model our contract on UCP concepts (capabilities, catalog/cart/checkout, `continue_url`-style handoff, idempotency keys). The Shopify adapter targets Shopify's UCP/MCP endpoints. Later, ACE can **expose** a UCP/MCP endpoint per tenant so external agents (Gemini, ChatGPT) can shop our merchants' stores, which is a second product. | 1, 9, later |

### 3.2 Adjustments to choices in the brief

| # | Brief said | Change | Why |
|---|---|---|---|
| J1 | `EcommerceProvider` with `productId`/`customerId` arguments and no tenant, error or write semantics. | A `CommerceProvider` **instance per store** (credentials bound at construction). Writes take `{ idempotencyKey }`. Errors are typed. A `capabilities` set lets adapters declare what they support. Money is integer **minor units + ISO currency**. Cart operations are line-level (`addCartLines`, `updateCartLine` where 0 removes). `lookupOrder` requires a `VerifiedIdentity`. `listProducts(updatedSince)` exists for sync. Cart `attributes` carry attribution. | Prevents cross-tenant leaks, double-adds on retry, float rounding bugs, and platform mismatch (not every platform supports every op). |
| J2 | Build our own `LLMProvider` abstraction (OpenAI/Anthropic/…). | Use the **Vercel AI SDK** (v7, open-source, runs on any Node host: provider-agnostic `ToolLoopAgent`, tool approvals, streaming, structured output) with the direct provider packages for **Google Gemini, OpenAI and Anthropic Claude**. Model IDs are per-bot config: one conversation model plus one cheap model for query rewrite, enrichment and summaries. The default is chosen by the Phase 2 language evals; the owner leans towards Gemini for Sinhala/Tamil/Singlish. | The SDK already is that abstraction; building our own is wasted work. |
| J3 | Redis + BullMQ for jobs. | **pg-boss** (Postgres-backed queue) in v1. Redis only if measured load needs it. | One fewer service to run, back up and secure. Postgres is already required. |
| J4 | Build the store backend from scratch ("Your Ecommerce Backend → PostgreSQL"). | **Recommended:** build the reference store on **Medusa v2** (open-source, TypeScript, Postgres; carts, inventory, orders, regions and admin included) with our own Next.js storefront, a PayHere payment provider and COD. The "own store adapter" becomes `adapter-medusa`, reusable for every future store we build for clients. *(Decision D1, §11.)* | A from-scratch commerce backend (orders, inventory, payments, admin) is months of work that is not our product. The AI layer is the product. |
| J5 | Monorepo with `ecommerce-core` **and** `commerce-contracts`, three separate worker apps, and `connectors/` at the top level. | One contracts package (`@ace/contracts`). Adapters are packages (`@ace/adapter-*`). **One** worker app with multiple job types. No `ecommerce-core`. | YAGNI: fewer packages and deployables, and clear ownership. |
| J6 | `tool_logs` stores the full `result`. | Store redacted results (PII stripped) with a size cap. Full payloads only in short-retention traces. | PDPA and storage cost. |
| J7 | "The LLM decides which tool to call" for every action. | Deterministic UI actions (an "Add to cart" button on a product card, a quantity stepper) call the engine directly **without** the LLM. The LLM handles intent and conversation; the UI handles clicks. | Faster, cheaper, and impossible to misinterpret. |
| J8 | RAG answers policy questions. | RAG answers include **citations**. If retrieval confidence is low, the agent says it is not sure and offers a human, instead of guessing. | Policy answers have legal weight. |
| J9 | `knowledge_documents` holds `embedding` per document. | Documents → **chunks** (with embeddings) → versioned. Re-embedding is tracked by model version. | Retrieval works on chunks; model upgrades need re-embedding. |

---

## 4. Architecture

```text
 Shopper ──► Channels ────────────────────────────────────────────────┐
             • Web widget (script + Shadow DOM, SSE)                  │
             • WhatsApp (Phase 10)                                    │
                                                                      ▼
 ┌────────────────────────────── ENGINE (apps/engine, Hono) ──────────────────────────────┐
 │ Gateway: widget key + origin check · rate limit · tenant resolution · identity · consent │
 │                                                                                         │
 │ Agent runtime (packages/agent, AI SDK ToolLoopAgent)                                    │
 │   prompt composer (tenant persona + policies) · session state · guardrails · approvals  │
 │   tool registry ← built from adapter capabilities + tenant config                       │
 │        │                     │                         │                                │
 │   commerce tools        knowledge tools           handoff tool                          │
 │        │                (packages/knowledge)      (inbox + notify)                      │
 │        ▼                                                                                │
 │   IndexedCatalogProvider (packages/search) ── read model: FTS + pgvector + filters      │
 │        │  (discovery only; live re-check before price/cart/checkout)                    │
 │        ▼                                                                                │
 │   CommerceProvider (packages/contracts)                                                 │
 └────────┼────────────────────────────────────────────────────────────────────────────────┘
          ▼
   adapter-memory (tests/evals) · adapter-medusa (reference store) · adapter-shopify (UCP/MCP)
   · adapter-woocommerce · adapter-custom-http
          ▼
   Store platforms (source of truth for products, prices, stock, carts, orders)

 WORKER (apps/worker, pg-boss): webhook processing · catalog sync + reconciliation
   · enrichment · embeddings · knowledge ingestion · retention purge · usage rollups

 POSTGRES (+pgvector, RLS by tenant_id): tenants, stores, bots, conversations, messages,
   tool_calls, handoffs, consents, usage_ledger, product read model, knowledge chunks, jobs
```

### 4.1 Packages and apps

| Unit | Responsibility | Depends on |
|---|---|---|
| `@ace/contracts` | Types, Zod schemas, `CommerceProvider` interface, `CommerceError`, capabilities, conformance test suite. **No runtime dependencies besides Zod.** | zod |
| `@ace/adapter-memory` | In-memory reference adapter with a seeded clothing catalog. Used by tests, evals and local dev. | contracts |
| `@ace/adapter-medusa` | Reference-store adapter (Medusa Store API + Admin API for sync and order lookup). | contracts |
| `@ace/adapter-shopify` | Shopify via UCP/Storefront MCP (catalog, cart, checkout) + Admin API webhooks. | contracts |
| `@ace/agent` | Tool definitions, `ToolContext`, session state, prompt composition, guardrails, the agent loop. Platform-agnostic. | contracts, ai |
| `@ace/search` | Read model, enrichment, hybrid search, `IndexedCatalogProvider` decorator. | contracts, db |
| `@ace/knowledge` | Document ingestion, chunking, embeddings, retrieval with citations. | db, ai |
| `@ace/db` | Drizzle schema, migrations, RLS policies, tenant-scoped query helper, credential encryption. | drizzle, pg |
| `@ace/widget` | Embeddable chat UI (single script, Shadow DOM), product cards, cart events. | — |
| `@ace/evals` | Golden conversations, scorers, CLI runner. | agent, adapter-memory |
| `apps/engine` | HTTP API (chat SSE, UI actions, webhooks ingress, admin API). | all core packages |
| `apps/worker` | Background jobs. | search, knowledge, db |
| `apps/reference-store` | Medusa backend + Next.js storefront for the first client. | (separate deployable) |
| `apps/dashboard` | Merchant inbox, settings, analytics (minimal in v1). | engine admin API |

### 4.2 Commerce contract (v1)

Defined exactly in the Phase 1 plan. Summary:

```ts
interface CommerceProvider {
  readonly platform: string;                         // "memory" | "medusa" | "shopify" | …
  readonly capabilities: ReadonlySet<Capability>;    // catalog.search, catalog.read, catalog.list,
                                                     // inventory.read, cart.write, checkout.handoff, orders.lookup
  searchProducts(input: SearchProductsInput): Promise<SearchProductsResult>;
  getProduct(productId: string): Promise<Product | null>;
  listProducts(input: ListProductsInput): Promise<ListProductsResult>;    // for sync
  getInventory(variantIds: string[]): Promise<InventoryLevel[]>;
  createCart(input: CreateCartInput, opts: WriteOptions): Promise<Cart>;
  getCart(cartId: string): Promise<Cart | null>;
  addCartLines(cartId: string, input: AddCartLinesInput, opts: WriteOptions): Promise<Cart>;
  updateCartLine(cartId: string, input: UpdateCartLineInput, opts: WriteOptions): Promise<Cart>; // qty 0 removes
  createCheckout(cartId: string, opts: WriteOptions): Promise<CheckoutHandoff>;               // URL handoff
  lookupOrder(input: LookupOrderInput): Promise<Order | null>;  // null if missing OR not owned by identity
  listOrders(input: ListOrdersInput): Promise<Order[]>;         // identity-scoped
}
```

Later contract versions add `shipping.quote` (`getShippingOptions`) and `orders.place_cod` (`placeCodOrder`, Phase 5).
Every adapter must pass `describeProviderConformance` from `@ace/contracts/testing`.

### 4.3 Agent design

- **Loop:** AI SDK `ToolLoopAgent`, step limit 8 per turn, streaming to the channel.
- **ToolContext (server-side, never from the model):** `tenantId`, `storeId`, `conversationId`, `provider`, `cartId`
  (from the host site), `identity: VerifiedIdentity | null`, `locale`, `session` (last-shown results, preferences),
  `idempotencyKey(turnId, toolCallId)`.
- **Tools v1:** `search_products`, `get_product`, `check_availability`, `view_cart`, `add_to_cart`,
  `update_cart_line`, `start_checkout`, `search_knowledge`, `lookup_order` (requires identity, else returns
  `needs_verification`), `start_verification`, `request_human`. Recommendation and comparison are done by the model over
  `search_products` and `get_product` results; there are no separate tools until evals show a need.
- **Structured UI parts:** tools return data that the channel renders as cards (product, cart, checkout button, order
  status). The model's text refers to them; prices shown to the shopper come from these parts.
- **Prompt composition:** fixed safety core + tenant persona (name, tone, languages) + store facts (currency, delivery
  regions) + tool-use rules. Tenants edit only the persona section.
- **Guardrails:** input length cap; tool outputs wrapped as untrusted data; business rules in code (max quantity, allowed
  actions); approval step for order placement; output validator for prices and links; topic boundary (politely declines
  unrelated requests); no system-prompt disclosure.
- **Memory:** in-conversation history with summarisation after N turns; session state as above; long-term shopper
  preferences (size, style) only with consent (Phase 7+).
- **Language:** reply in the shopper's language; normalise the query to catalog vocabulary before search.

### 4.4 Search and knowledge

- **Phase 2–5:** search delegates to the adapter's native search (live).
- **Phase 6:** `IndexedCatalogProvider` serves `searchProducts` from the read model:
  1. query normalisation (LLM, cheap model) → `{ text, filters }`;
  2. Postgres full-text search + pgvector similarity, fused with Reciprocal Rank Fusion;
  3. structured filters (category, options, price, in-stock);
  4. business rules (boost in-stock, hide drafts, merchant pins);
  5. live availability re-check on the top results.
- **Knowledge:** markdown/PDF/URL ingestion → chunks (~500 tokens, overlap) → embeddings → retrieval top-k with a score
  threshold → answer with citations or "not sure → offer human".

### 4.5 Data model (Postgres, every table has `tenant_id` + RLS)

`tenants`, `tenant_users`, `stores` (platform, encrypted credentials, config), `widget_keys` (publishable key, allowed
origins), `bots` (persona, models, languages, limits), `conversations` (channel, shopper ref, status, attribution),
`messages`, `tool_calls` (redacted input/output, latency, error code), `handoffs`, `verifications` (OTP, hashed),
`consents`, `usage_ledger` (tokens, cost, messages), `catalog_products` / `catalog_variants` (read model + enriched
attributes + embedding), `knowledge_documents` / `knowledge_chunks`, `webhook_events` (dedupe), `eval_runs`.
Credentials are envelope-encrypted with a KMS or a master key from the environment. Engine DB access goes through
`withTenant(tenantId, fn)`, which sets the RLS session variable.

### 4.6 Security and privacy

- Tenant isolation: RLS + scoped provider instances + per-tenant credentials.
- Widget: publishable key (not secret), origin allow-list, CORS, rate limits, signed host-session tokens for identity.
- Secrets never reach the model or the browser.
- PII: redaction in logs/traces, retention (default 180 days for messages, 30 days for traces), deletion/export API,
  consent records, DPA template, provider data-retention settings. The breach-notification runbook is ready before
  1 Jan 2027.
- Webhooks: HMAC verification, replay window, dedupe.

### 4.7 Observability, evals, cost

- Trace per turn: model, prompt version, tokens, cost, tool calls (name, latency, error), final outcome.
- KPIs: resolution rate, handoff rate, add-to-cart rate, checkout-start rate, chat-assisted revenue, cost per
  conversation, p95 first-token latency (< 2 s target).
- Evals: golden conversations per capability and language; must pass before merging agent or prompt changes.
- Budgets: per-tenant monthly cap. At 80% the merchant is alerted; at 100% the engine falls back to the cheap model
  and then to a "contact us" mode.

---

## 5. Error handling

| Situation | Behaviour |
|---|---|
| Adapter `UPSTREAM_UNAVAILABLE` / `RATE_LIMITED` | Retry with backoff (max 2) inside the tool; then the tool returns a typed failure; the agent tells the shopper and offers handoff. |
| `OUT_OF_STOCK` on add | The agent offers other sizes or colours from live inventory. |
| `NOT_SUPPORTED` capability | The tool is not registered for that tenant, so the model never sees it. |
| Order lookup without identity | The tool returns `needs_verification` and the agent starts OTP. |
| LLM provider error | Retry once; fail over to the secondary model; then a static apology with a contact link. |
| Budget exhausted | Degrade as in §4.7. |
| Webhook signature invalid | 401, logged, not processed. |

## 6. Testing strategy

- Unit tests (Vitest) for every package; TDD.
- **Adapter conformance suite** run by every adapter (memory in CI; real adapters against sandboxes, nightly).
- Agent tests with a mocked language model for deterministic tool-routing tests.
- Evals with real models (scheduled + on prompt/model changes).
- Integration tests for the engine with Postgres (Testcontainers or a Neon branch).
- End-to-end browser tests of widget + reference store before the pilot.

## 7. Delivery phases

See the [Roadmap](../plans/2026-10-08-roadmap.md). Phase 1 is fully planned in
[2026-10-08-phase-1-foundation.md](../plans/2026-10-08-phase-1-foundation.md). Each later phase gets its own detailed plan
when it starts, so it can use what the earlier phases taught us.

## 8. Tech stack

| Concern | Choice |
|---|---|
| Language / runtime | TypeScript (strict), Node.js ≥ 22 (24 LTS recommended), ESM |
| Product name | Not final — `ACE` / `@ace/*` is a placeholder (D5) |
| Monorepo | pnpm workspaces + Turborepo |
| Validation | Zod v4 |
| Tests / lint | Vitest; Biome |
| HTTP | Hono on `@hono/node-server` (long-running Node process) |
| AI | Vercel AI SDK v7 (`ToolLoopAgent`, tool approvals, embeddings) with `@ai-sdk/google`, `@ai-sdk/openai`, `@ai-sdk/anthropic`; the model is chosen per bot |
| DB | Postgres 16+ with pgvector (Docker on the VPS, daily off-site backups), Drizzle ORM, RLS |
| Hosting | VPS (Ubuntu LTS) + Docker Compose: `engine`, `worker`, `postgres`, `reference-store`, Caddy (TLS + reverse proxy); GitHub Actions builds images and deploys over SSH |
| Jobs | pg-boss |
| Widget | Preact + Shadow DOM, bundled to one script with esbuild |
| Dashboard | Next.js (App Router) |
| Reference store | Medusa v2 + Next.js storefront; PayHere + COD |

## 9. Risks

| Risk | Mitigation |
|---|---|
| Model gives wrong price, stock or policy | Grounding rules, UI from tool data, validators, evals. |
| Singlish/Sinhala understanding is weak for some models | Language evals in Phase 2 pick the model; query normalisation step. |
| Platform APIs change (e.g., Shopify renamed `search_shop_catalog` → `search_catalog` during its UCP migration) | Adapters isolated + nightly conformance against sandboxes. |
| Solo-developer scope creep | Strict phase exit criteria; non-goals list. |
| LLM cost per conversation too high for local pricing | Cheap-model routing, caching, budget caps, cost KPI tracked from Phase 3. |

## 10. Decisions log

| ID | Decision | Status |
|---|---|---|
| DL1 | Agent talks only to `CommerceProvider`; adapters per platform. | Accepted (from brief) |
| DL2 | Live data authoritative; read model for discovery only. | Accepted |
| DL3 | Checkout via handoff URL; COD placement only with explicit confirmation. | Accepted |
| DL4 | AI SDK instead of a custom LLM abstraction. | Accepted |
| DL5 | Postgres-only infra in v1 (pgvector, pg-boss). | Accepted |
| DL6 | Contract vocabulary aligned with UCP concepts. | Accepted |
| DL7 | Hosting on a VPS with Docker Compose (not Vercel/serverless). | Accepted 2026-10-08 (owner) |

## 11. Open decisions (need the owner's answer before the phase that needs them)

| ID | Question | Recommendation | Needed by |
|---|---|---|---|
| D1 | Reference store: Medusa v2 or a from-scratch backend? | **Decided: Medusa v2** (ADR-006) | — |
| D2 | Hosting | **Decided: VPS + Docker Compose** (DL7) | — |
| D3 | Default LLM provider and fallback | Candidates are **Gemini, OpenAI and Claude** (owner leans Gemini for Sinhala/Tamil/Singlish). Pick the primary and fallback from Phase 2 language and tool-use evals, plus cost per conversation | Phase 2 |
| D4 | Pilot client confirmed? Their languages, delivery regions and COD share | **Not confirmed (2026-10-09).** Reference store built generically: LKR, English/Sinhala/Tamil, PayHere + COD, island-wide flat delivery (ADR-006). Revisit when a pilot signs | Phase 5 |
| D5 | Product name and package scope | Not finalised. `ACE` / `@ace/*` is a working placeholder; renaming is a find-and-replace until Phase 3 | Before public launch |
| D6 | Business model: per-store subscription, per-conversation, or revenue share | Subscription + included conversations | Phase 8 |

## 12. Sources consulted (2026-10-08)

- Shopify: [AI commerce at scale / UCP](https://www.shopify.com/news/ai-commerce-at-scale) · [Storefront MCP](https://shopify.dev/docs/agents/catalog/storefront-mcp) · [Agents: carts and checkout](https://shopify.dev/docs/agents/carts-and-checkout) · [Build a cart](https://shopify.dev/docs/agents/get-started/build-a-cart) · [Community: `search_shop_catalog` → `search_catalog`](https://community.shopify.dev/t/storefront-mcp-search-shop-catalog-returning-tool-not-found-renamed-to-search-catalog/33256)
- UCP overview: [Let's Data Science](https://www.letsdatascience.com/blog/google-launches-universal-commerce-protocol-to-standardize-agentic-shopping) · [UCP Checker, Feb 2026](https://ucpchecker.com/blog/state-of-agentic-commerce-february-2026)
- ACP: [Stripe docs](https://docs.stripe.com/agentic-commerce/protocols/acp) · [Crossmint comparison](https://crossmint.com/learn/agentic-payments-protocols-compared)
- WooCommerce: [Canonical abilities (10.9)](https://developer.woocommerce.com/2026/05/12/mcp-abilities-api-10-9/) · [WooCommerce MCP](https://woocommerce.com/posts/woocommerce-mcp/)
- AI SDK: [Tool approvals](https://ai-sdk.dev/v7/docs/agents/tool-approvals) · [ToolLoopAgent](https://ai-sdk.dev/v7/docs/reference/ai-sdk-core/tool-loop-agent)
- WhatsApp: [Meta pricing docs](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing) · [Oct 2026 change summary](https://help.getdarwin.ai/en/articles/16516839-whatsapp-business-platform-pricing-changes-service-messages-billed-starting-october-2026)
- Sri Lanka PDPA: [FT.lk — compliance regime from 1 Jan 2027](https://www.ft.lk/front-page/Data-protection-compliance-regime-takes-effect-on-1-Jan-2027/44-795776) · [Daily Mirror — staggered rollout](https://www.dailymirror.lk/breaking-news/Legal-experts-flag-unique-compliance-landscape-in-staggered-PDPA-rollout/108-346685)
- PayHere: [Checkout API](https://support.payhere.lk/api-&-mobile-sdk/checkout-api)
- OWASP LLM Top 10 2025: [Invicti summary](https://www.invicti.com/blog/web-security/owasp-top-10-risks-llm-security-2025)
- Medusa payment providers: [MONEI Medusa plugin docs](https://docs.monei.com/e-commerce/medusa/)
