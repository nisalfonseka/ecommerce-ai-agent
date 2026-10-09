# Phase 3 — Engine API and Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Draft (2026-10-09). Implementation starts once Phase 2's exit criteria are met and D3 is decided (roadmap rule). Decisions **E1** and **E2** below need the owner's answer before Tasks 7 and 9.

**Goal:** A multi-tenant HTTP engine that runs `@ace/agent` turns for real shoppers. It covers widget-key auth, chat over Server-Sent Events, deterministic UI actions, Postgres persistence with row-level security, engine-owned idempotency (ADR-002), per-turn traces, a usage ledger with budgets, and a Docker Compose deployment for the VPS.

**Architecture:** `@ace/db` owns the Drizzle schema, SQL migrations (roles, forced RLS, one `SECURITY DEFINER` lookup) and `withTenant(db, tenantId, fn)`. Every query runs inside a transaction that sets `app.tenant_id`. `apps/engine` (Hono on `@hono/node-server`) resolves the tenant from a publishable widget key. It builds a `ToolContext` around an `IdempotentCommerceProvider` (a Postgres-backed decorator over the store's adapter), runs `runTurn`, and persists messages, session state, redacted tool calls, usage and a trace in one tenant-scoped transaction. Replies are delivered over SSE.

**Tech Stack:** Hono 4 + `@hono/node-server` 2, Drizzle ORM 0.45 + drizzle-kit 0.31, `pg` 8 (shared with pg-boss in Phase 6), Postgres 16, Zod 4, pino, `@opentelemetry/api` (+ optional `@opentelemetry/sdk-node`), esbuild (engine bundle), Docker Compose + Caddy.

**Spec:** design spec §3 G1, G5, G8, G13, G15, G16, J6, J7; §4.3, §4.5–§4.7; §5. Workflow §C, §J, §K. ADR-001, ADR-002. Roadmap Phase 3.

## Global Constraints

- Everything in Phase 1 and Phase 2's Global Constraints still applies.
- **Only `packages/db` talks SQL.** The engine uses repository functions; the db package exports no raw pool to apps except through `withTenant` and the two definer lookups.
- **Every tenant table:** `tenant_id uuid not null`, `ENABLE` + `FORCE ROW LEVEL SECURITY`, one policy `tenant_isolation` with `USING` and `WITH CHECK` on `tenant_id = current_setting('app.tenant_id', true)::uuid`. If the setting is missing, `NULL` matches nothing.
- **Roles:** migrations run as the database owner. The engine connects as `ace_app` (`NOSUPERUSER NOBYPASSRLS`, DML only). Tests prove isolation using `ace_app`, never the owner.
- **Shopper data:** every table that stores shopper data is registered in `SHOPPER_DATA_TABLES` (with retention days) for the Phase 6/7 purge and export jobs (AGENTS.md). Tool inputs/outputs and traces are stored **redacted**. Messages are stored as written, with retention.
- **Secrets:** store credentials are envelope-encrypted (AES-256-GCM data key, wrapped by `ACE_MASTER_KEY`). The admin API key and conversation-token secret come from the environment. None of these ever reach logs, traces, the model or the browser.
- **Integration tests** need Postgres via `ACE_TEST_DATABASE_URL` (an owner/superuser URL; each test file creates and drops its own database). Locally `scripts/test-postgres.sh` starts a throwaway cluster. CI uses a `postgres:16` service. DB tests are `describe.skipIf(!url)`, and CI fails if they were skipped.
- **No later-phase scaffolding:** no worker app, no pg-boss, no pgvector, no handoff/consent/verification tables.

## Decisions for the owner (answer before the named task)

| ID | Question | Recommendation | Needed by |
|---|---|---|---|
| E1 | The spec wants prices/links checked before the shopper sees them (§C7), and also p95 first token < 2 s (§4.7). Live token streaming cannot satisfy the first rule. | **Buffered reply + live status events.** Stream `status` events while tools run ("Searching dresses…", well under 2 s), then send the validated reply and its UI parts. Measure real latency on staging. Revisit sentence-level streaming with retraction only if shoppers notice. Record as ADR-004. | Task 7 |
| E2 | Budget enforcement needs a price per model. Prices change and differ by provider. | An owner-maintained `model-prices.json` (USD per 1M input/output tokens, with source URL and date). Bots can only use models listed there. Soft cap → the bot's cheap model; hard cap → "contact us" reply. Merchant alert at 80% (logged in Phase 3; notifications in Phase 7). | Task 9 |

## Review Focus

1. **Tenant isolation.** A query without `withTenant`, or with tenant A's context, never returns tenant B's rows, including through the widget-key lookup and conversation IDs guessed from another tenant. (Task 2, Task 4, Task 8.)
2. **Conversation hijack.** Knowing a `conversationId` is not enough to read or continue it. A signed conversation token bound to tenant and conversation is required. (Task 6.)
3. **Concurrent turns.** Two messages for the same conversation at once: the second gets `409 turn_in_progress`; session state and history are never interleaved or lost. A crashed turn's lease expires. (Task 8.)
4. **Idempotency (ADR-002).** A replayed write with the same key returns the stored result. The same key with a different input is `CONFLICT`. An ambiguous failure of `addCartLines` is reconciled against the cart, never re-applied blindly. (Task 5.)
5. **PII in logs and traces.** Emails, phone numbers (`+94…`, `07…`) and card-like digit runs are redacted in tool-call records, traces and logs. Secrets never appear. (Task 3, Task 8.)

---

## File Structure

```text
packages/agent/src/
  context.ts, tools/registry.ts, prompt.ts, index.ts      # Task 1 (modify): tool log + status hook, PROMPT_VERSION

packages/db/
  package.json, tsconfig.json, drizzle.config.ts          # Task 2
  migrations/0000_init.sql, 0001_rls.sql                  # Task 2 (generated + hand-written)
  src/schema.ts                                           # Task 2: tables
  src/client.ts           (+ .test.ts)                    # Task 2: createDb, withTenant, Db/Tx types
  src/migrate.ts                                          # Task 2: runMigrations(ownerUrl), ensureAppRole
  src/testing.ts                                          # Task 2: createTestDatabase() (db tests only)
  src/rls.test.ts                                         # Task 2: isolation proof (exit criterion)
  src/crypto.ts           (+ .test.ts)                    # Task 3: sealSecret / openSecret
  src/shopper-data.ts     (+ .test.ts)                    # Task 3: SHOPPER_DATA_TABLES registry
  src/redact.ts           (+ .test.ts)                    # Task 3: redactPii / redactDeep
  src/repos/admin.ts      (+ .test.ts)                    # Task 4: tenants, stores, bots, widget keys
  src/repos/conversations.ts (+ .test.ts)                 # Task 4: conversation lease, messages, session
  src/repos/telemetry.ts  (+ .test.ts)                    # Task 4: tool_calls, usage_ledger, turn_traces
  src/repos/idempotency.ts                                # Task 5
  src/index.ts

apps/engine/
  package.json, tsconfig.json, build.mjs                  # Task 6
  model-prices.json                                       # Task 9 (owner-maintained, E2)
  src/config.ts           (+ .test.ts)                    # Task 6: env schema
  src/app.ts                                              # Task 6: createApp(deps) → Hono
  src/main.ts                                             # Task 6: process entry
  src/log.ts                                              # Task 6: pino with redaction
  src/idempotent-provider.ts (+ .test.ts, conformance.test.ts)  # Task 5
  src/providers.ts        (+ .test.ts)                    # Task 5: store → CommerceProvider factory (memory only)
  src/auth/widget.ts      (+ .test.ts)                    # Task 6: key + origin + CORS
  src/auth/conversation-token.ts (+ .test.ts)             # Task 6
  src/rate-limit.ts       (+ .test.ts)                    # Task 6
  src/turn.ts             (+ .test.ts)                    # Task 7: runChatTurn (lease → agent → persist)
  src/routes/chat.ts      (+ .test.ts)                    # Task 7: POST /v1/chat (SSE)
  src/routes/conversations.ts (+ .test.ts)                # Task 7: GET /v1/conversations/:id
  src/routes/actions.ts   (+ .test.ts)                    # Task 8: POST /v1/actions/:type
  src/budget.ts           (+ .test.ts)                    # Task 9: prices, cost, budget state, model fallback
  src/routes/admin.ts     (+ .test.ts)                    # Task 10
  src/seed.ts                                             # Task 10: two demo tenants
  src/telemetry.ts                                        # Task 9: optional OTel exporter

Dockerfile, docker-compose.yml, deploy/Caddyfile, deploy/backup.sh, .dockerignore   # Task 11
.github/workflows/ci.yml (modify), .github/workflows/deploy.yml                      # Task 11 / 12
scripts/test-postgres.sh                                                            # Task 2
docs/adr/004-reply-delivery.md, docs/adr/005-tenancy-in-postgres.md                 # Tasks 2, 7
```

---

### Task 1: Agent hooks for the engine

**Files:** Modify `packages/agent/src/context.ts`, `src/tools/registry.ts`, `src/prompt.ts`, `src/agent.ts`, `src/index.ts`. Tests: `context.test.ts`, `tools/registry.test.ts`, `agent.test.ts`.

**Interfaces:**
- `ToolContext.toolLog: ToolLogEntry[]`, where `ToolLogEntry = { name: string; startedAt: number; ms: number; ok: boolean; errorCode?: ToolFailureCode }`.
- `CreateToolContextInput.onToolStart?: (name: string) => void`, for SSE status events. It is never given tool input, because that may contain PII.
- `PROMPT_VERSION = "2026-10-09.1"`, exported. `TurnResult.promptVersion`.

- [x] **Step 1: Failing tests.**
  - `buildTools`' `execute` appends one `toolLog` entry per call, with `ok:false` and the code for a failed `ToolResult` (driven through `runTurn` with a scripted model, because `ToolSet` types tool inputs as `never`).
  - `onToolStart` is called with the tool name before `run`.
  - `runTurn` returns `promptVersion === PROMPT_VERSION`.
- [x] **Step 2: Implement** in `buildTools`, wrapping `def.run`. Bump `PROMPT_VERSION` whenever `prompt.ts` text changes (prompt changes are versioned code changes, per AGENTS.md).
- [x] **Step 3:** `pnpm lint && pnpm typecheck && pnpm test`. These are non-behavioural agent changes; a short `pnpm evals --only refs --rpm 5` run confirms no regression (deferred: the free-tier daily quota was used up; it runs with the next eval batch).
- [x] **Step 4: Commit** `feat(agent): tool timing log, status hook and prompt version`.

---

### Task 2: `@ace/db` — schema, roles, RLS and `withTenant`

**Files:** Create the `packages/db` shell, `drizzle.config.ts`, `src/schema.ts`, `src/client.ts`, `src/migrate.ts`, `src/testing.ts`, `src/rls.test.ts`, `migrations/*`, `scripts/test-postgres.sh`, `docs/adr/005-tenancy-in-postgres.md`. Modify `.github/workflows/ci.yml`.

**Interfaces:**
- `createDb(url: string): { db: Db; close(): Promise<void> }` (`pg.Pool` + Drizzle).
- `withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T>`. It opens a transaction, runs `select set_config('app.tenant_id', $1, true)` and calls `fn`. It throws on a non-UUID tenant ID before touching the database.
- `runMigrations(ownerUrl: string, appPassword: string): Promise<void>`. It applies the migrations folder and creates or updates role `ace_app` with the given password and grants.
- `createTestDatabase(): Promise<{ ownerUrl; appUrl; drop(): Promise<void> } | null>` (`null` when `ACE_TEST_DATABASE_URL` is unset).

**Tables** (`uuid` PKs default `gen_random_uuid()`, `created_at timestamptz default now()`):

| Table | Columns (besides id, tenant_id, created_at) | Notes |
|---|---|---|
| `tenants` | name, status | `tenant_id = id` (check constraint), so the same policy applies |
| `stores` | platform, credentials_sealed (bytea, nullable), config jsonb, currency | |
| `bots` | store_id, persona jsonb, store_facts jsonb, model, cheap_model, fallback_model (nullable), budget_soft_usd_micros, budget_hard_usd_micros, max_steps | |
| `widget_keys` | bot_id, key_hash (unique, sha256 hex), key_prefix, allowed_origins text[], revoked_at | the plaintext key is shown once |
| `conversations` | bot_id, channel, visitor_id, session jsonb, cart_id, summary, busy_until, status, last_message_at | |
| `messages` | conversation_id, seq int, kind (`model` \| `action`), payload jsonb (a `ModelMessage` or an action event), display jsonb (text + UI parts for GET) | unique (conversation_id, seq) |
| `tool_calls` | conversation_id, turn_id, name, input_redacted jsonb, output_redacted jsonb (≤ 8 kB), ok, error_code, ms | |
| `turn_traces` | conversation_id, turn_id, model, prompt_version, input_tokens, output_tokens, cost_usd_micros (nullable), latency_ms, steps, tool_names text[], outcomes text[], regenerated, ungrounded_count, error | |
| `usage_ledger` | bot_id, conversation_id, turn_id, model, input_tokens, output_tokens, cost_usd_micros | monthly sums for budgets |
| `idempotency_records` | store_id, operation, target, key, fingerprint, status (`in_progress` \| `completed` \| `ambiguous`), result jsonb, reconcile jsonb, updated_at | unique (tenant_id, store_id, operation, target, key) |

`migrations/0001_rls.sql` (hand-written; drizzle-kit does not emit roles or `FORCE`):

```sql
-- For each tenant table T:
ALTER TABLE T ENABLE ROW LEVEL SECURITY;
ALTER TABLE T FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON T
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- The one cross-tenant read the engine needs: widget key → tenant. Owner rights, returns only routing data.
CREATE FUNCTION resolve_widget_key(p_key_hash text)
RETURNS TABLE (tenant_id uuid, bot_id uuid, allowed_origins text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT tenant_id, bot_id, allowed_origins FROM widget_keys
  WHERE key_hash = p_key_hash AND revoked_at IS NULL
$$;
-- Because FORCE RLS also binds the owner, the function sets the context itself:
-- implement as plpgsql: PERFORM set_config('app.tenant_id', (SELECT tenant_id::text FROM widget_keys_lookup ...), true)
-- or keep widget_keys_lookup (key_hash, tenant_id, bot_id, allowed_origins, revoked_at) WITHOUT RLS,
-- owned by the owner, with no grant to ace_app. Chosen: the lookup table (simpler, auditable).
REVOKE ALL ON FUNCTION resolve_widget_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION resolve_widget_key(text) TO ace_app;
```

Final design for the lookup (as built): `widget_key_lookup(key_hash pk, tenant_id, bot_id, allowed_origins, revoked_at)` has no RLS and no grants to `ace_app`. A `SECURITY DEFINER` trigger on `widget_keys` keeps it in sync, so `ace_app` never writes it directly. `resolve_widget_key` reads only this table. Record the reasoning in ADR-005.


**As built:**
- Policies use `nullif(current_setting('app.tenant_id', true), '')::uuid`. After a transaction-local `set_config`, a pooled connection reads the setting as `''`, which would otherwise raise an error instead of matching nothing.
- Role creation tolerates parallel migrations, because roles are cluster-wide.
- `turbo.json` declares `ACE_TEST_DATABASE_URL` and `ACE_REQUIRE_DB_TESTS` on the `test` task, so strict env mode passes them through and they are part of the cache key.

- [x] **Step 1: `scripts/test-postgres.sh`.** `initdb` into `$TMPDIR/ace-pg`, start on port 54329 with `pg_ctl`, print `ACE_TEST_DATABASE_URL=postgres://$USER@localhost:54329/postgres`. Idempotent; `stop` subcommand.
- [x] **Step 2: Failing tests** in `src/rls.test.ts` (as `ace_app`):
  1. Rows inserted for tenant A are invisible under tenant B, for **every** tenant table (iterate the schema).
  2. An insert with tenant B's `tenant_id` while in tenant A's context fails (`WITH CHECK`).
  3. Without `withTenant` (plain query on the pool), selects return 0 rows and inserts fail.
  4. `ace_app` cannot read `widget_key_lookup` directly, but `resolve_widget_key` works.
  5. `withTenant(db, "not-a-uuid", …)` throws before any query.
  6. `set_config` is transaction-local: a pooled connection reused after `withTenant` has no tenant.

  Plus `src/client.test.ts`: `withTenant` returns `fn`'s value and rolls back when it throws.
- [x] **Step 3: Implement** the schema, `drizzle-kit generate` → `0000_init.sql`, hand-write `0001_rls.sql`, `runMigrations`, `createTestDatabase`.
- [x] **Step 4: CI.** Add a `postgres:16` service to `ci.yml` with `ACE_TEST_DATABASE_URL`, and a step that fails if the db tests report skipped (`ACE_REQUIRE_DB_TESTS=1` makes `createTestDatabase` throw instead of returning null).
- [x] **Step 5:** ADR-005 (roles, forced RLS, transaction-local `app.tenant_id`, lookup table). Run checks; commit `feat(db): schema, forced RLS and withTenant`.

---

### Task 3: Secret sealing, PII redaction, shopper-data registry

**Files:** `packages/db/src/crypto.ts`, `redact.ts`, `shopper-data.ts` (+ tests).

**Interfaces:**
- `sealSecret(plaintext: string, masterKey: Buffer): Buffer` and `openSecret(sealed: Buffer, masterKey: Buffer): string`. Format: version byte ‖ wrapped data key (GCM) ‖ nonce ‖ ciphertext ‖ tag. A fresh data key per value. `masterKey` must be 32 bytes.
- `redactPii(text: string): string`. Emails → `[email]`. Phone numbers (E.164 and Sri Lankan `0[1-9]\d{8}`) → `[phone]`. Digit runs of 13–19 (cards) → `[number]`. Order numbers and prices are kept.
- `redactDeep(value: unknown, maxBytes = 8192): unknown` redacts every string and truncates large values with a `[truncated]` marker.
- `SHOPPER_DATA_TABLES: { table: string; retentionDays: number; subject: "conversation" }[]`. Covers `conversations` (180), `messages` (180), `tool_calls` (30), `turn_traces` (30), `usage_ledger` (none; holds no shopper data, so it is excluded and the test documents why).

- [x] **Step 1: Failing tests.**
  - The seal round-trip works.
  - A tampered byte → throws.
  - A wrong master key → throws.
  - Two seals of the same text differ.
  - A 31-byte master key is rejected.
  - Redaction table tests: `+94771234567`, `0771234567`, `a.b@x.lk`, `4111 1111 1111 1111`, `ACE-1001` (kept), `LKR 18,500.00` (kept).
  - The registry test: every table in `schema.ts` that has a `conversation_id` column is in `SHOPPER_DATA_TABLES`.
- [x] **Step 2: Implement; checks; commit** `feat(db): secret sealing, PII redaction and shopper-data registry`.

---

### Task 4: Repositories

**Files:** `packages/db/src/repos/admin.ts`, `conversations.ts`, `telemetry.ts` (+ tests against `createTestDatabase`).

**Interfaces** (all take `tx: Tx` from `withTenant`, except the two marked *pool*):
- Admin:
  - `createTenant(db /* pool */, name): Promise<{ tenantId }>`, which inserts under its own new ID via `withTenant`.
  - `createStore(tx, { platform, currency, config, credentialsSealed? })`.
  - `createBot(tx, BotInput)`.
  - `issueWidgetKey(tx, { botId, allowedOrigins }): Promise<{ key: string /* pk_live_… shown once */, prefix }>`, which writes `widget_keys` and `widget_key_lookup`.
  - `revokeWidgetKey(tx, keyId)`.
  - `resolveWidgetKey(db /* pool */, key): Promise<{ tenantId, botId, allowedOrigins } | null>`.
  - `getBotWithStore(tx, botId)`.
- Conversations:
  - `createConversation(tx, { botId, channel, visitorId })`.
  - `acquireTurnLease(tx, conversationId, leaseMs): Promise<ConversationRow | null>`. It runs `UPDATE … SET busy_until = now() + lease WHERE id = $1 AND (busy_until IS NULL OR busy_until < now()) RETURNING *`, and returns `null` when the conversation is busy.
  - `loadHistory(tx, conversationId): Promise<{ messages: ModelMessage[]; nextSeq }>`. Action rows become `{ role: "user", content: "[shopper action] …" }`.
  - `appendMessages(tx, conversationId, startSeq, rows)`.
  - `saveSessionAndRelease(tx, conversationId, { session, cartId })`.
  - `getConversationForDisplay(tx, conversationId)`.
- Telemetry:
  - `recordToolCalls(tx, rows)`, with input and output passed through `redactDeep`.
  - `recordTurn(tx, { trace, usage })`.
  - `monthToDateCostMicros(tx, botId, now)`.

**As built:**
- `@ace/db` stays free of the AI SDK. `loadMessages` returns stored JSON rows and the engine maps them to `ModelMessage`s (action rows become shopper-action notes).
- `createTenant` accepts an explicit `id`, so seeds re-run with deterministic IDs (RLS hides lookups by name).
- `usageReport(tx, month)` gives cost, turns, conversations and the average per conversation.

- [x] **Step 1: Failing tests.**
  - A widget key resolves; a revoked key → `null`; an unknown key → `null`.
  - Only the hash is stored (the plaintext never appears in any row).
  - A second `acquireTurnLease` while one is held → `null`; it succeeds after expiry.
  - `appendMessages` with a duplicate `seq` fails (unique), so a racing turn cannot interleave.
  - History round-trips assistant tool calls and tool results unchanged.
  - Tool-call inputs are stored redacted.
  - The month-to-date cost sums only the current calendar month (UTC).
- [x] **Step 2: Implement; checks; commit** `feat(db): admin, conversation and telemetry repositories`.

---

### Task 5: `IdempotentCommerceProvider` and the provider factory (ADR-002)

**Files:** `packages/db/src/repos/idempotency.ts`. `apps/engine/src/idempotent-provider.ts` (+ unit test with an in-memory record store, + `conformance.test.ts` against Postgres). `apps/engine/src/providers.ts` (+ test).

**Interfaces:**
- `interface IdempotencyStore { begin(rec): Promise<"new" | { status, fingerprint, result, reconcile }>; complete(rec, result); markAmbiguous(rec, reconcile); }`, with a Postgres implementation in `repos/idempotency.ts` (`INSERT … ON CONFLICT DO NOTHING RETURNING`) and an in-memory one for unit tests.
- `class IdempotentCommerceProvider implements CommerceProvider`, built with `(inner, store, { storeId })`. Reads pass through. Each write:
  1. `fingerprint = sha256(canonicalJson({ operation, target, input }))`.
  2. `begin`. `"new"` → run the write. On success → `complete`. On `CommerceError` → delete the record (atomic writes changed nothing, so a retry may run again). On any other error (timeout or network after send) → `markAmbiguous` with a pre-write snapshot, then rethrow as `UPSTREAM_UNAVAILABLE`.
  3. Existing with a different fingerprint → `CONFLICT`. `completed` → return the stored result. `in_progress` → `CONFLICT` (retryable: false, message "still processing").
  4. `ambiguous` + `addCartLines` → `getCart`, and compare each line's quantity with `reconcile.before[variantId] + requested`. If it reached that → treat as applied (complete with the current cart). Otherwise run the write once. `ambiguous` for other operations → run again; they are absolute (`updateCartLine`, `updateCartAttributes`) or have no cart side effect (`createCheckout`). An ambiguous `createCart` can leave one orphan empty cart, which is acceptable.
- `createProviderFactory({ db, masterKey }): (tenantId, store) => CommerceProvider`. `platform: "memory"` → a cached `MemoryCommerceProvider` per (tenant, store), wrapped. Unknown platform → throws `NOT_SUPPORTED`.

**As built:**
- `IdempotencyStore` is `{ begin, complete, markAmbiguous, remove }`, with a Postgres store (`@ace/db`, `createPgIdempotencyStore(db, tenantId)`) and an in-memory one (`createMemoryIdempotencyStore`, for tests).
- A record left `in_progress` for more than 2 minutes (a crashed request) is treated as ambiguous.
- `createProviderFactory({ idempotencyStore: (tenantId) => store })`.
- Known limitation: two *concurrent* replays of the same ambiguous record could both re-run the write. Replays come from one turn's retry, so this is unlikely. If it shows up, add a compare-and-set claim (`ambiguous → in_progress`).

- [x] **Step 1: Failing tests.**
  - The conformance suite (`describeProviderConformance`) passes against `IdempotentCommerceProvider(new MemoryCommerceProvider(), pgStore)`. This is the ADR-002 consequence.
  - Unit: replay → identical result and the inner provider is called once.
  - Same key with another input → `CONFLICT`.
  - Inner throws `OUT_OF_STOCK` → no record left, and a retry with the same key runs again.
  - Inner throws a timeout after applying → the replay finds the line already added and does **not** add twice.
  - Inner throws a timeout before applying → the replay adds once.
- [x] **Step 2: Implement; checks; commit** `feat(engine): Postgres-backed idempotent provider (ADR-002)`.

---

### Task 6: Engine shell — config, logging, widget auth, conversation tokens, rate limits

**Files:** `apps/engine/package.json` (`build`: `node build.mjs`; `start`: `node dist/main.js`; `dev`: `tsx watch src/main.ts`), `tsconfig.json`, `build.mjs` (esbuild: bundle `@ace/*` source, keep npm packages external), `src/config.ts`, `src/log.ts`, `src/app.ts`, `src/main.ts`, `src/auth/*`, `src/rate-limit.ts` (+ tests).

**Interfaces:**
- `loadConfig(env): EngineConfig`, via a Zod schema. Fields:
  - `DATABASE_URL` (the app role)
  - `ACE_MASTER_KEY` (base64, 32 bytes)
  - `ADMIN_API_KEY_SHA256` (hex)
  - `CONVERSATION_TOKEN_SECRET` (≥ 32 bytes)
  - `PORT` (default 8080)
  - `LOG_LEVEL`
  - `TRUST_PROXY_HOPS` (default 1, for Caddy)
  - provider keys (optional)
  - `OTEL_EXPORTER_OTLP_ENDPOINT` (optional)

  Errors name the variable, never its value.
- `createApp(deps: { config, db, providers, now?, models? }): Hono`. `GET /healthz` checks the db (`select 1`) and returns `{ ok }`.
- `authenticateWidget(c)`: reads `Authorization: Bearer pk_…`, then `resolveWidgetKey`. The `Origin` must be in `allowedOrigins`; otherwise 403 (no CORS headers). Preflight `OPTIONS` reflects only allowed origins.
- `signConversationToken({ tenantId, conversationId }): string` / `verifyConversationToken(token): { tenantId, conversationId } | null` (HMAC-SHA256, base64url, constant-time compare).
- `createRateLimiter({ perVisitorPerMinute: 20, perIpPerMinute: 60 })`. It is in-memory, per process (the engine runs as one process on the VPS; a Postgres-backed limiter is the upgrade path if it ever scales out). `check(key): { ok } | { ok: false; retryAfterS }`.
- Error shape for every route: `{ error: { code, message } }`. Codes: `unauthorized`, `forbidden_origin`, `rate_limited`, `invalid_input`, `not_found`, `turn_in_progress`, `internal`.

- [ ] **Step 1: Failing tests** (Hono `app.request`, no network).
  - Missing, unknown or revoked key → 401.
  - A wrong Origin → 403 with no `Access-Control-Allow-Origin`.
  - The right Origin → CORS headers set.
  - A token for conversation A does not verify for B or for another tenant; a tampered token → null.
  - The limiter blocks the 21st request in a minute and recovers.
  - `loadConfig` rejects a short master key and does not echo it.
  - The logger redacts emails and phones in messages and fields.
- [ ] **Step 2: Implement; checks; commit** `feat(engine): config, widget auth, conversation tokens and rate limits`.

---

### Task 7: Chat turn over SSE (requires E1)

**Files:** `apps/engine/src/turn.ts`, `src/routes/chat.ts`, `src/routes/conversations.ts` (+ tests). `docs/adr/004-reply-delivery.md`.

**SSE contract** (`POST /v1/chat`, body `{ conversationId?, conversationToken?, message, cartId?, locale? }`):

```text
event: conversation  data: {"conversationId":"…","conversationToken":"…"}      (first, always)
event: status        data: {"tool":"search_products"}                         (0..n, while tools run)
event: reply         data: {"text":"…","ui":[…],"cartId":"…"|null}             (once, validated)
event: done          data: {}
event: error         data: {"code":"…","message":"…"}                         (instead of reply)
```

The host site sends `cartId` with each message. If a tool created or replaced the cart, `reply.cartId` returns the new one so the widget can emit `ace:cart-updated`.

**`runChatTurn(deps, input, emit)`:**
1. Authenticate (Task 6), apply the rate limit, check the message (`checkUserMessage`).
2. Create or verify the conversation (a token is required for an existing ID; a mismatch → 404, the same as "missing").
3. `withTenant` → `acquireTurnLease` (60 s). Busy → `409 turn_in_progress`. Load the history, session and bot+store.
4. Build the `ToolContext`: the provider from the factory, `cartId` from the request (falling back to the stored one), `onToolStart` → `emit("status")`, and `onUnexpectedError` → log.
5. Choose the model from budget state (Task 9; until then `bot.model`). Run `runTurn`. On a provider `APICallError` → retry once with `bot.fallbackModel` if set; otherwise reply with the bot's static apology (`error` code `model_unavailable`).
6. If `ungroundedAmounts.length > 0` → send the reply text with each ungrounded amount replaced by `[see the product card]` and add an outcome tag `grounding_scrubbed`. The UI parts still carry the real prices.
7. One transaction: append messages (user + new), save the session/cart and release the lease, record the redacted tool calls and the trace + usage. Then emit `reply` + `done`.
8. On any failure after the lease: release the lease (`busy_until = null`) in `finally`.

`GET /v1/conversations/:id` (widget key + conversation token) returns the display rows: user text, assistant text, UI parts. No tool payloads.

- [ ] **Step 1: Failing tests** (scripted model from `@ace/agent/testing`, test database).
  - The happy path emits `conversation`, `status(search_products)`, `reply` (with a `product_list` UI part), `done`, in that order.
  - Rows are persisted: messages, session refs, tool call (redacted), trace with `promptVersion`, usage.
  - A second turn using the same conversation sees the first turn's `#refs` ("#2" adds the right variant).
  - A concurrent turn → 409, and the first still completes.
  - A thrown model error with no fallback → `error` event, and the lease is released.
  - A fallback model is used when the primary throws `APICallError`.
  - Tenant B's widget key with tenant A's conversation ID + token → 404.
  - An ungrounded amount is scrubbed from the text and tagged.
- [ ] **Step 2:** ADR-004 (E1 outcome). Implement; checks; commit `feat(engine): chat turns over SSE with leases, persistence and traces`.

---

### Task 8: Deterministic UI actions

**Files:** `apps/engine/src/routes/actions.ts` (+ test).

`POST /v1/actions/:type` with types `add_to_cart` (`{ variantId, quantity }`), `update_cart_line` (`{ lineId, quantity }`), `view_cart`, `start_checkout`. Each requires a conversation token, runs the matching tool definition from `ALL_TOOLS` directly (no LLM) with the same `ToolContext` and lease, appends an `action` message (`"[shopper action] added Navy Cotton Kurta (M) ×1"` or the failure), and returns `{ result: ToolResult, ui: UiPart[], cartId }`. The idempotency key is the client-sent `actionId` (UUID, required), so a double click does not add twice.

- [ ] **Step 1: Failing tests.**
  - The action adds to the cart, and the next chat turn's history contains the action note.
  - The same `actionId` twice → one line.
  - An unknown type → 404.
  - No token → 401.
  - An action while a turn holds the lease → 409.
- [ ] **Step 2: Implement; checks; commit** `feat(engine): deterministic UI actions`.

---

### Task 9: Budgets, cost and telemetry (requires E2)

**Files:** `apps/engine/model-prices.json`, `src/budget.ts`, `src/telemetry.ts` (+ tests).

**Interfaces:**
- `loadModelPrices(json): Map<modelSpec, { inputPerMTokUsdMicros, outputPerMTokUsdMicros, source, checkedOn }>`.
- `costMicros(prices, modelSpec, usage): number | null`, in integer micro-dollars. This is not shopper-facing money, but still integer.
- `budgetState(spentMicros, bot): "ok" | "alert" | "soft" | "hard"` (alert ≥ 80% of soft).
- `chooseModel(bot, state): { model: string } | { contactOnly: true }`.
- `startTelemetry(config)`: when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, start the OTel Node SDK. `runTurn` gets `telemetry: { isEnabled: true, recordInputs: false, recordOutputs: false }` so prompts and replies (PII) never leave in spans.
- Admin validation: a bot's `model`, `cheapModel` and `fallbackModel` must exist in the price table.

- [ ] **Step 1: Failing tests.**
  - Cost arithmetic is integer and rounds up.
  - An unknown model → null cost, and bot creation rejects it.
  - The state transitions at 80% / 100% soft / 100% hard.
  - Soft → the cheap model is used for the turn; hard → a static "contact us" reply without calling any model.
  - The turn trace stores the cost.
- [ ] **Step 2: Implement.** The owner fills `model-prices.json` from the providers' pricing pages; the plan ships it with the structure and `"checkedOn": null` placeholders, and startup refuses bots whose models have no price. Checks; commit `feat(engine): usage cost, budgets and optional OpenTelemetry`.

---

### Task 10: Admin API and demo seed

**Files:** `apps/engine/src/routes/admin.ts`, `src/seed.ts` (+ test). Root script `pnpm seed`.

- Every `/admin/*` route requires `Authorization: Bearer <admin key>`, comparing its SHA-256 with `ADMIN_API_KEY_SHA256` in constant time.
- Routes:
  - `POST /admin/tenants`
  - `POST /admin/tenants/:id/stores`
  - `POST /admin/tenants/:id/bots`
  - `POST /admin/tenants/:id/bots/:botId/widget-keys` (returns the key once)
  - `DELETE …/widget-keys/:keyId`
  - `GET /admin/tenants/:id/usage?month=2026-10` (cost per conversation: total, conversations, average; the exit criterion "cost per conversation visible")
- `pnpm seed` creates "Demo Clothing A" and "Demo Clothing B" (memory adapter, LKR, persona, the default model from D3) with widget keys for `http://localhost:5173`, and prints the keys.

- [ ] **Step 1: Failing tests.**
  - No or wrong admin key → 401.
  - The full create flow works, and the widget key from it authenticates `/v1/chat`.
  - Usage for tenant A excludes tenant B.
  - The seed is idempotent (by tenant name).
- [ ] **Step 2: Implement; checks; commit** `feat(engine): admin API and demo tenant seed`.

---

### Task 11: Container build, Compose and CI

**Files:** `Dockerfile` (multi-stage: pnpm install → `pnpm --filter @ace/engine build` → `node:24-slim` runtime, non-root user, `HEALTHCHECK` on `/healthz`), `.dockerignore`, `docker-compose.yml`, `deploy/Caddyfile`, `deploy/backup.sh`. Modify `.github/workflows/ci.yml`.

`docker-compose.yml` services:
- `postgres` (`postgres:16`, a named volume, no published port).
- `migrate` (one-shot: `node dist/migrate.js` as owner).
- `engine` (depends on migrate; env from `.env.production`, not committed).
- `caddy` (80/443, `reverse_proxy engine:8080`, automatic TLS for `$ACE_DOMAIN`).
- `backup`: a nightly `pg_dump -Fc` to a mounted directory, kept 14 days, plus an optional `rclone` copy to the off-site target configured by the owner.

- [ ] **Step 1:** CI gains a `docker build .` job (no push) so the image always builds.
- [ ] **Step 2:** Locally: `docker compose up` (where Docker is available), then `pnpm seed` against it and `curl -N` a chat turn with the memory adapter and a scripted model flag (`ACE_FAKE_MODEL=1`, accepted only when `NODE_ENV !== "production"`), to prove the stack without API keys.
- [ ] **Step 3: Commit** `chore(deploy): engine image, compose stack, Caddy and backups`.

---

### Task 12 (owner-gated): Staging on the VPS

Needs Phase 0's VPS, domain, DNS and off-site backup target.

- [ ] Owner: provision the VPS (Ubuntu LTS, Docker, SSH key login, firewall 22/80/443, unattended upgrades). Point `staging.<domain>` at it. Add repository secrets `STAGING_SSH_HOST`, `STAGING_SSH_USER`, `STAGING_SSH_KEY`, and put `.env.production` on the server.
- [ ] `.github/workflows/deploy.yml`: on push to `main` (manual approval via a GitHub environment), build the image, push to GHCR, then SSH `docker compose pull && docker compose up -d`, then smoke `GET /healthz`.
- [ ] Uptime alert: an external checker on `/healthz` (the owner picks the service).
- [ ] Run the exit checks below on staging.

## Phase 3 exit checklist

- [ ] RLS test proves tenant A cannot read tenant B (every tenant table), in CI against Postgres.
- [ ] A chat turn streams end-to-end on staging (status events, then the reply) for both demo tenants.
- [ ] Cost per conversation is visible via `GET /admin/tenants/:id/usage`.
- [ ] Conformance passes against the idempotent provider over Postgres.
- [ ] E1 and E2 answered; ADR-004 and ADR-005 written.
- [ ] `pnpm lint && pnpm typecheck && pnpm test` green, including the db integration tests in CI.
