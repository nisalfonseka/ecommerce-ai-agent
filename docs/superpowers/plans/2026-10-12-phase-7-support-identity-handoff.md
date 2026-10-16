# Phase 7 — Support, Identity, Handoff and Privacy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** Implementation and local exit verification are complete on `main` (2026-10-16); the strict PostgreSQL/RLS and order-access suites are green. Owner decisions received 2026-10-12: SMS = **text.lk**, email = **Brevo**, staff handoff alerts = **email**, retention periods = **per merchant**. Everything here runs locally and in CI without paid accounts, using a log-only notifier; real delivery, live evals and provider retention checks are owner-gated, so the phase exit is not yet fully signed off.

**Goal:** A shopper can verify with an SMS or email code (or a signed host-site session) and then look up their own orders; the assistant hands difficult conversations to a human who answers from a minimal dashboard inbox and is alerted by email; and the merchant side of Sri Lanka's PDPA works: consent records, per-merchant retention, shopper export and deletion, a DPA template and a breach runbook.

**Architecture:** Identity is built server-side only. The engine issues and checks one-time codes (`verifications`, HMAC-hashed), sends them through a `Notifier` (`@ace/notify`: text.lk SMS, Brevo email, log-only for dev), and stores the resulting `VerifiedIdentity` on the conversation with a 30-minute expiry. The model never sees a code. `identityMatches` is tied to the verification method, so an email code can only match an order's email and a phone code only its phone. Handoff is a conversation state (`open → handoff → open|closed`): while a human owns it the agent stays silent, shopper messages are stored for staff, and staff replies reach the widget by polling. Staff use an `apps/dashboard` Next.js inbox that talks to `/staff/v1/*` with per-tenant staff tokens. Shopper data is findable by an HMAC of the verified email/phone (`identity_hash`), so export and deletion need no raw contact data at rest.

**Tech Stack:** Hono, Drizzle/Postgres (RLS), pg-boss, Zod, Next.js 16 (dashboard), Preact (widget), Vitest, Playwright. text.lk REST API v3 (`POST https://app.text.lk/api/v3/sms/send`, `Authorization: Bearer <token>`, JSON `{recipient, sender_id, type: "plain", message}`, recipient as `94XXXXXXXXX`). Brevo REST API v3 (`POST https://api.brevo.com/v3/smtp/email`, header `api-key`, JSON `{sender:{name,email}, to:[{email}], subject, textContent}`, verified sender required). Re-check both vendors' docs when implementing Task 3.

**Spec:** §3 G1, G4, G13; §4.5 (`verifications`, `consents`, `handoffs`); §4.6; workflow §G, §H, §K; AGENTS.md rules 5, 6, 13 and "Security and privacy". Roadmap Phase 7.

## Global Constraints

- Phase 1–6 constraints and every rule in `AGENTS.md` apply.
- **Identity is never model-supplied.** `ToolContext.identity` is built by the engine from a verified, unexpired conversation identity or a verified host-session token. No tool input accepts an email, phone or customer id for authorization.
- **One-time codes:** 6 digits, 10 minute expiry, at most 5 wrong attempts per code, then the code is dead. Stored only as `HMAC-SHA256(codeKey, code ‖ salt)`, compared in constant time, single use. A code never appears in a tool result, trace, log, message row, UI part or model prompt.
- **Verified identity lifetime:** 30 minutes from verification (workflow §G), then the conversation is anonymous again.
- **Send limits (defaults, per tenant settings can only tighten them):** 3 sends per destination per hour, 5 per conversation per hour, 20 per IP per hour. SMS only to country codes in `tenant_settings.otp.allowedCountryCodes` (default `["94"]`), which blocks SMS pumping to premium ranges.
- **No enumeration:** `verify_start` answers identically whether or not any order exists for the destination. An order lookup answers `NOT_FOUND` identically for "missing" and "not yours" (AGENTS.md rule 6).
- **No raw contact data in logs, traces, tool-call records or error messages.** Destinations in logs are `e***@d***.com` / `+94*****1234` masks only. Summaries written for staff go through `redactPii`.
- **Hash keys come from `ACE_MASTER_KEY`** by domain-separated derivation (`HKDF-SHA256`, labels `ace/otp/v1`, `ace/identity-hash/v1`), never a second secret to manage.
- **Handoff silence is enforced in code**, not by the prompt: a conversation in `handoff` never reaches the model.
- **Every new table has `tenant_id`, forced RLS and an entry in `TENANT_TABLES`.** Shopper-data tables are registered in `SHOPPER_DATA_TABLES` with a retention default and join the purge, export and delete jobs.
- **Staff access is least-privilege:** a staff token can read and answer that tenant's handoffs and nothing else.
- **Production sender safety:** the log-only notifier is refused when `NODE_ENV=production`.
- **No later-phase scaffolding:** no WhatsApp (Phase 10), no pilot onboarding automation (Phase 8), no Shopify adapter changes (Phase 9), no agent-run returns or refunds.

## Decisions (defaults are built; changing one is configuration or an ADR, not a rewrite)

| ID | Question | Default built in this plan |
|---|---|---|
| P7-1 | How does staff sign in to the dashboard? | **Staff access tokens**, issued per tenant by the admin API (`st_<tenantId>.<secret>`, hashed at rest, revocable). The dashboard keeps the token in an HttpOnly cookie. No passwords, no email-link login in v1. Email magic links can replace this later without changing `/staff/v1`. |
| P7-2 | Where do shoppers' contact details live? | **Nowhere in clear.** `identity_hash` (HMAC) on the conversation for lookup; a contact the shopper leaves for staff is sealed (`sealSecret`) on the handoff row and deleted with it. |
| P7-3 | How do staff replies reach the shopper? | **Polling** `GET /v1/conversations/:id` every 5 s while `status = handoff` (Postgres-only infrastructure, AGENTS.md rule 15). SSE push can come later. |
| P7-4 | Host-site login (`ACE.setIdentity`) | The engine verifies tokens signed with a per-tenant secret (HS256-style HMAC, `exp` ≤ 24 h) that the merchant's server mints. The reference storefront has guest checkout only and mints nothing in this phase; a documented snippet shows merchants how. |
| P7-5 | Which handoff triggers are automatic? | In code: shopper asks for a person (model calls `request_human`), any refund/cancellation/return intent (prompt rule + tool), two consecutive tool failures that block progress, two consecutive `search_knowledge` misses. Negative sentiment is model-judged through the same tool. |
| P7-6 | Provider data-retention settings | A checklist doc (Task 9). **Verification needs the owner's provider accounts** and is owner-gated. |

## Review Focus

1. **Reading an order without verification.** Every path must fail closed: tool call, UI action, chat text claiming "I'm verified", expired identity, another conversation's token, identity from a different tenant, host-session token with a bad signature, wrong tenant or past `exp` (Task 4 and 5 tests).
2. **OTP abuse.** Brute force (attempt cap, lockout), SMS pumping (country allow-list, three limit layers), code replay and reuse, a code requested for a different destination than the one confirmed, timing differences, and user enumeration through response shape or latency (Task 4 tests).
3. **Identity confusion.** An email-OTP identity must never match an order by phone, and the reverse. `+94771234567`, `0771234567` and `94771234567` normalise to one phone; email case is folded but gmail dots/plus tags are not (Task 1 tests).
4. **Handoff races.** Messages arriving while a human claims, two staff claiming at once, a hand-back mid-turn, notification retried (one email per handoff), and a staff token of tenant A touching tenant B's handoff (Task 6 tests).
5. **Deletion completeness.** After a delete request, no row in any shopper-data table, no queued job carrying the shopper's data, and no export of another shopper's data from a shared visitor id (Task 9 tests).

---

## File Structure

```text
packages/contracts/src/identity.ts                      # method-tied matching, schema refinements          (Task 1)
packages/db/src/schema.ts, migrations/0005_phase7.sql, 0006_phase7_rls.sql                                 (Task 2)
packages/db/src/repos/{tenant-settings,verifications,consents,handoffs,staff,privacy}.ts                    (Tasks 2, 4, 6, 9)
packages/db/src/shopper-data.ts                         # + handoffs, verifications, consents              (Task 2)
packages/notify/src/{notifier,textlk,brevo,log,index}.ts + tests                                          (Task 3)
apps/engine/src/identity/{hash,otp,host-session,conversation-identity}.ts + tests                           (Task 4)
apps/engine/src/routes/{actions,chat,admin,staff,consent,privacy}.ts                                        (Tasks 4–9)
apps/engine/src/handoff/{service,triggers}.ts                                                              (Task 6)
packages/agent/src/tools/{verification,orders,handoff}.ts, prompt.ts, ui.ts, context.ts                    (Tasks 5, 6)
packages/evals/src/cases/{orders,handoff}.ts                                                              (Tasks 5, 6)
apps/worker/src/handlers/{handoff-notify,shopper-export,shopper-delete,retention}.ts                       (Tasks 6, 9)
packages/widget/src/{host,api,state}.ts, ui/{verify,handoff}.tsx                                           (Task 7)
apps/dashboard/                                         # Next.js inbox                                    (Task 8)
docs/legal/dpa-template.md, docs/runbooks/breach.md, docs/runbooks/provider-retention.md                   (Task 9)
docs/adr/010-identity-and-otp.md, 011-handoff-and-staff-access.md                                          (Tasks 4, 6)
```

Dependency direction (AGENTS.md): `apps/*` → `packages/agent|notify|db` → `packages/contracts`. `@ace/notify` depends on nothing internal. The agent depends on neither `@ace/notify` nor `@ace/db`; it sees only interfaces on `ToolContext`.

---

### Task 1: Identity semantics in the contract (G1 hardening)

**Files:** Modify `packages/contracts/src/identity.ts`, `src/identity.test.ts`, `src/testing/conformance.ts`, `src/testing/fixtures.ts`, `packages/adapter-memory/src/seed.ts` (fixtures only), `docs/adr/001-commerce-contract.md` (note).

**Interfaces — Produces:**

```ts
// VerifiedIdentitySchema gains method-specific rules (refine):
//   email_otp:    email required; phone and externalCustomerId must be absent
//   phone_otp:    phone required; email and externalCustomerId must be absent
//   host_session: externalCustomerId required; email/phone allowed only as host-verified values
export function normalizePhone(input: string, defaultCountryCode?: string /* "94" */): string | null; // E.164 or null
export function normalizeEmail(input: string): string | null;                                          // trim + lowercase; null if invalid
// identityMatches(identity, owner): tied to identity.method
//   email_otp    → owner.email only
//   phone_otp    → owner.phone only
//   host_session → owner.externalCustomerId, or owner.email / owner.phone when the identity carries them
```

- [x] **Step 1: Failing tests.**
  - Schema: an `email_otp` identity with a phone is rejected; `phone_otp` with an email is rejected; `host_session` without `externalCustomerId` is rejected; each valid shape parses.
  - `identityMatches` negatives: an `email_otp` identity never matches an owner that only has the same value in `phone`; a `phone_otp` never matches by email; an `email_otp` identity whose email equals `owner.email` after case folding matches; `phone_otp` `+94771234567` matches an owner stored as `+94771234567`.
  - `normalizePhone`: `0771234567`, `94771234567`, `+94 77 123 4567`, `077-1234567` → `+94771234567`; `12345`, `+0771234567`, letters → `null`. `normalizeEmail`: `"  A@B.com "` → `a@b.com`; `a+tag@gmail.com` stays as is; `not-an-email` → `null`.
  - Conformance (shared suite): a COD order placed with phone and email is found by `phone_otp` with the phone, found by `email_otp` with the email, and **not** found by a `phone_otp` whose phone is the shopper's email-only counterpart. Add the cases to `describeProviderConformance` and run them over the memory adapter and the idempotent wrapper.
- [x] **Step 2: Implement.** Keep the exported names; update memory and Medusa adapters only if their tests fail (they should keep passing because both already call `identityMatches`). Run the Medusa conformance only when `ACE_MEDUSA_SEED_OUTPUT` is set, as before.
- [x] **Step 3:** `pnpm lint:fix && pnpm lint && pnpm typecheck && pnpm test`. Commit `feat(contracts): tie identity matching to the verification method`.

### Task 2: Phase 7 tables, RLS and repos

**Files:** Modify `packages/db/src/schema.ts`, `src/shopper-data.ts`, `src/index.ts`, `src/rls.test.ts`. Create `migrations/0005_phase7.sql` (generated), `migrations/0006_phase7_rls.sql` (hand-written, same style as `0003`), `src/repos/{tenant-settings,verifications,consents,handoffs,staff,privacy}.ts` and their tests.

**Interfaces — Produces (Drizzle columns; every table also has `id uuid pk`, `tenant_id`, `created_at`):**

```ts
tenantSettings { tenantId pk; retention jsonb;            // { messagesDays 30..730 (180), tracesDays 7..90 (30), handoffDays 30..730 (180), otpHours 1..72 (24) }
                 handoffEmails text[]; otp jsonb;          // { allowedCountryCodes: string[], channels: ("sms"|"email")[] }
                 requireConsent boolean default true; privacyNoticeUrl text|null;
                 hostSessionSecretSealed bytea|null; contactInfo text|null /* shown on "not sure" answers */ }
verifications { conversationId FK cascade; channel text ('sms'|'email'); destinationHash text; destinationSealed bytea; codeHash text; salt text;
                attempts int default 0; expiresAt timestamptz; consumedAt timestamptz|null }
consents      { conversationId FK cascade; noticeVersion text; noticeUrl text|null }
handoffs      { conversationId FK cascade; reason text; summary text; status text ('open'|'claimed'|'resolved');
                claimedBy text|null; contactSealed bytea|null; notifiedAt timestamptz|null; resolvedAt timestamptz|null }
staffTokens   { name text; tokenHash text unique; tokenPrefix text; revokedAt timestamptz|null }
privacyRequests { type text ('export'|'delete'|'offboard'); subjectHash text|null; status text; counts jsonb; completedAt timestamptz|null }
conversations += identity jsonb|null /* VerifiedIdentity + expiresAt */, identityHash text|null (index), 
                 handoffOpenedAt timestamptz|null;  status values: 'open'|'handoff'|'closed'
messages.kind += 'staff'
```

- [x] **Step 1: Failing tests.** `rls.test.ts` iterates `TENANT_TABLES`: extend the fixture so each new table has a row per tenant; tenant A reads zero of B's rows and cannot insert with B's `tenant_id`. Repo tests: settings defaults when no row; `getRetention` clamps out-of-range values; a verification row cascades with its conversation; `handoffs` status transitions reject going backwards; staff token lookup by hash only inside `withTenant`.
- [x] **Step 2: Implement.** `SHOPPER_DATA_TABLES` gains `{ handoffs, 180 }`, `{ verifications, 1 day → retention otpHours }`, `{ consents, 180 }`; update `shopper-data.test.ts` (it asserts every table with a `conversationId` column is registered or exempt; `privacy_requests` holds no shopper content and is exempt).
- [x] **Step 3:** Checks (DB tests need `ACE_TEST_DATABASE_URL`). Commit `feat(db): tenant settings, verifications, consents, handoffs and staff tokens with RLS`.

### Task 3: `@ace/notify` — text.lk SMS and Brevo email

**Files:** Create `packages/notify/{package.json,tsconfig.json,vitest.config.ts}` and `src/{notifier,textlk,brevo,log,mask,index}.ts` with tests.

**Interfaces — Produces:**

```ts
export type NotifyErrorCode = "unauthorized" | "rejected" | "rate_limited" | "unavailable" | "invalid_destination";
export class NotifyError extends Error { constructor(readonly code: NotifyErrorCode, message: string, readonly cause?: unknown) }
export interface Notifier {
  sendSms(input: { to: string /* E.164 */; text: string }): Promise<{ providerId: string | null }>;
  sendEmail(input: { to: string; subject: string; text: string }): Promise<{ providerId: string | null }>;
}
export function createTextLkSms(opts: { apiToken: string; senderId: string; fetch?: typeof fetch; timeoutMs?: number }): Pick<Notifier, "sendSms">;
export function createBrevoEmail(opts: { apiKey: string; sender: { name: string; email: string }; fetch?: typeof fetch; timeoutMs?: number }): Pick<Notifier, "sendEmail">;
export function createLogNotifier(log: (line: string) => void): Notifier;   // masks destination, never prints the body in production-like mode
export function createNotifier(env: Record<string, string | undefined>): Notifier;  // TEXTLK_* + BREVO_* ; ACE_NOTIFY_MODE=log only when NODE_ENV !== "production"
export function maskDestination(value: string): string;   // "+94*****4567", "a***@e***.com"
```

- [x] **Step 1: Failing tests** (injected `fetch`, no network).
  - text.lk: URL `https://app.text.lk/api/v3/sms/send`, method POST, headers `Authorization: Bearer <token>`, `Content-Type: application/json`, `Accept: application/json`, body `{ recipient: "94771234567", sender_id, type: "plain", message }` (the `+` is stripped); a 401 → `unauthorized`; 422 or `status: "error"` body → `rejected`; 429 → `rate_limited`; 5xx or a thrown fetch or timeout → `unavailable`; a non-`+94` destination passes through unchanged but a malformed one → `invalid_destination` before any request.
  - Brevo: URL `https://api.brevo.com/v3/smtp/email`, header `api-key`, body `{ sender, to: [{ email }], subject, textContent }`; 401 → `unauthorized`; 400 → `rejected`; 429 → `rate_limited`; 5xx → `unavailable`; success returns `messageId` as `providerId`.
  - Errors and logs never contain the token, the message text or the unmasked destination (assert on `error.message`, `String(error)` and the `log` calls).
  - `createNotifier`: missing vendor variables throw an error naming the variable; `ACE_NOTIFY_MODE=log` with `NODE_ENV=production` throws.
  - **No retries inside the senders** (a repeated SMS is a cost and a nuisance; callers decide). Say so in a comment.
- [x] **Step 2: Implement; checks.** Commit `feat(notify): text.lk SMS and Brevo email senders`.
- [ ] **Step 3 (owner-gated):** with a real text.lk token + approved sender ID and a Brevo key + verified sender, `pnpm --filter @ace/notify smoke --sms +94… --email …` sends one test message each. The script refuses to run without an explicit `--yes` and never prints secrets.

### Task 4: OTP verification, host sessions and identity on the turn (G1)

**Files:** Create `apps/engine/src/identity/{hash,otp,host-session,conversation-identity}.ts` (+ tests), `packages/db/src/repos/verifications.ts` functions, `docs/adr/010-identity-and-otp.md`. Modify `apps/engine/src/routes/{actions,chat,admin}.ts`, `src/turn.ts`, `src/main.ts`, `src/config.ts` (notifier env), `packages/agent/src/context.ts` (no change expected: `identity` already exists).

**Interfaces — Produces:**

```ts
// hash.ts — HKDF(ACE_MASTER_KEY) with labels; pure functions
export function deriveKey(masterKey: Buffer, label: "ace/otp/v1" | "ace/identity-hash/v1"): Buffer;
export function identityHash(key: Buffer, tenantId: string, kind: "email" | "phone", normalized: string): string;
export function hashCode(key: Buffer, code: string, salt: string): string;
// otp.ts
export interface OtpDeps { db: Db; notifier: Notifier; masterKey: Buffer; now?: () => Date; random?: (n: number) => Buffer; ipLimiter?: RateLimiter }
export type StartResult = { ok: true; maskedDestination: string; expiresInSeconds: 600 } | { ok: false; reason: "invalid_destination" | "channel_disabled" | "rate_limited" | "unavailable"; retryAfterSeconds?: number };
export function startVerification(deps: OtpDeps, ctx: { tenantId: string; conversationId: string; ip: string },
  input: { channel: "sms" | "email"; destination: string }): Promise<StartResult>;
export type ConfirmResult = { ok: true; identity: VerifiedIdentity } | { ok: false; reason: "invalid_code" | "expired" | "locked" | "no_pending" };
export function confirmVerification(deps: OtpDeps, ctx: { tenantId: string; conversationId: string },
  input: { code: string }): Promise<ConfirmResult>;
// host-session.ts
export function verifyHostSession(token: string, secret: Buffer, now?: Date): VerifiedIdentity | null;
export function signHostSession(claims: { sub: string; email?: string; emailVerified?: boolean; phone?: string; phoneVerified?: boolean; exp: number }, secret: Buffer): string; // for tests and docs
// conversation-identity.ts
export function currentIdentity(conversation: { identity: unknown; identityExpiresAt?: Date | string | null }, now: Date): VerifiedIdentity | null; // null once expired (30 min)
```

Engine behaviour:
- UI actions (existing `POST /v1/actions/:type`, same conversation-token auth): `verify_start { channel, destination }` and `verify_confirm { code }`. Responses: `{ ok, maskedDestination? }` / `{ ok, verified: true }` / `{ ok: false, reason }`. On success the identity (method `email_otp` or `phone_otp`, only the verified field, plus `verifiedAt`) and `identity_hash` are saved on the conversation with `identityExpiresAt = now + 30 min`, and an `action` message is appended so the next model turn knows verification happened (no PII in it).
- `POST /v1/chat` accepts `identityToken` (host session). A valid token produces a `host_session` identity for this turn only (not persisted beyond the turn); an invalid or expired token is ignored and the shopper stays anonymous (never an error that reveals why).
- `POST /admin/tenants/:tenantId/host-session-secret` generates, seals and returns the secret once (rotating invalidates old tokens), like the webhook secret.
- Rate limits: DB-backed counters over `verifications` rows for per-destination and per-conversation; the existing in-memory limiter for per-IP. All are enforced in `startVerification`, before any send.
- Send failure: the row is rolled back (no pending code) and the shopper gets `unavailable`; a `NotifyError` never carries the destination to the response.

- [x] **Step 1: Failing tests** (test database, fake `Notifier` recording sends, injected `now`/`random`).
  - Happy path SMS: start → one `sendSms` to the normalised number with a 6-digit code in the text; confirm with that code → identity `phone_otp` with only `phone`; saved on the conversation; `currentIdentity` is null at +30 min + 1 s and valid at +29 min.
  - Email path likewise; destination case folded.
  - **Review Focus 2:** 6th wrong attempt → `locked`, and the right code afterwards is still refused; a code is single use (second confirm → `no_pending`); an expired code (10 min + 1 s) → `expired`; the 4th start for one destination within an hour → `rate_limited`; the 6th start for one conversation → `rate_limited`; the 21st start from one IP → `rate_limited`; `+1…` destination with default settings → `invalid_destination` and no send; start for destination B then confirming the code that was sent to A is impossible (one pending code per conversation; a new start invalidates the old one).
  - Enumeration: the `StartResult` for a phone with orders and one without is byte-identical; both paths perform the same number of DB writes (assert on a counter or spy).
  - Constant time: `confirmVerification` uses `timingSafeEqual` on equal-length buffers (assert via a spy or by testing a wrong code of the same length and different length both return `invalid_code`).
  - **Review Focus 1:** with no identity, `lookup_order` → `NEEDS_VERIFICATION`; after verification the same call returns the order for the owner and `NOT_FOUND` for another shopper's order number; an expired identity behaves as none; conversation A's identity is never used for conversation B (including the same visitor id); a conversation token for tenant B cannot call `verify_confirm` for tenant A's conversation (404).
  - Host session: valid token → `host_session` identity for the turn; wrong signature, tampered payload, `exp` in the past, `exp` more than 24 h ahead, missing `sub`, other tenant's secret → anonymous; `emailVerified: false` drops the email from the identity.
  - Logs: run start and confirm with a capturing logger and assert no destination, code or message text appears.
- [x] **Step 2: Implement.** ADR-010: HMAC domain separation, why the code is hashed (database read exposure), 30-minute identity window, no enumeration, host sessions are per-turn. The normalized destination is envelope-encrypted because confirmation receives only a code; its HMAC remains the rate-limit and privacy lookup key.
- [x] **Step 3:** Checks. `pnpm lint`, all 13 package typechecks and all 22 test tasks passed with strict PostgreSQL tests on 2026-10-14. Commit `feat(engine): one-time code verification and host-session identity`.

### Task 5: Order-support tools, prompt and evals

**Files:** Create `packages/agent/src/tools/verification.ts`, `packages/evals/src/cases/orders.ts`. Modify `src/tools/{orders,registry}.ts`, `src/ui.ts`, `src/prompt.ts` (+ `PROMPT_VERSION`), `packages/evals/src/{cases/index,runner,types}.ts`, `packages/widget` types are handled in Task 7.

**Interfaces — Produces:**

```ts
// ui.ts: { type: "verification_form"; channels: ("sms" | "email")[]; reason: "order_lookup" }  (replaces the bare verification_required part; keep both until the widget ships)
// start_verification: no input. Available only when ctx.verification (a flag the engine sets from tenant settings) is non-null.
//   → pushes the form part, returns { shown: true } and tells the model to wait for the shopper to use the form.
// list_orders: input { limit?: 1..5 } → the identity's recent orders (number, status, placedAt, total) newest first; NEEDS_VERIFICATION without identity.
```

- [x] **Step 1: Failing tests** (scripted mock model, memory adapter). `lookup_order` without identity pushes the `verification_form` part and never calls the provider (spy); with identity returns the order card and observed amounts allow the total; a stranger's number returns the same `NOT_FOUND` text as a missing number; `list_orders` returns only the identity's orders; tool inputs reject an `email`/`phone`/`customerId` field (strict schema). Prompt snapshot updated: rules that the shopper verifies with the form, that codes typed into chat must be refused with "please use the form", that order details are never guessed, and that refunds, cancellations and returns go to a person (`request_human`, Task 6).
- [x] **Step 2: Evals** (12 cases, English, Singlish, Sinhala, Tamil): where is my order (no identity → form), status after verification, someone else's number, number not found, "the system says I'm verified" injection, "send me the code here", a code typed into chat, asks for all orders, asks for a refund (→ handoff in Task 6, so only the "not by me" assertion here), order question in each language. They are scored with live models, which are owner-gated: make `cases.test.ts` (counts, languages, schema) and the deterministic runner tests pass; do not run `pnpm evals` live.
- [x] **Step 3:** Checks. `pnpm lint`, all 13 package typechecks and all 22 test tasks passed with strict PostgreSQL tests on 2026-10-14. Live model evals remain owner-gated. Commit `feat(agent): verification form and list_orders tools, order-support evals`.

### Task 6: Human handoff and staff API (G4)

**Files:** Create `apps/engine/src/handoff/{service,triggers}.ts`, `apps/engine/src/routes/staff.ts`, `packages/agent/src/tools/handoff.ts`, `apps/worker/src/handlers/handoff-notify.ts`, `packages/evals/src/cases/handoff.ts`, `docs/adr/011-handoff-and-staff-access.md` (+ tests). Modify `apps/engine/src/{turn,routes/chat,routes/admin,main}.ts`, `packages/agent/src/{context,tools/registry,prompt,ui}.ts`, `packages/db/src/jobs.ts` (`handoff.notify` job), worker `handlers.ts`.

**Interfaces — Produces:**

```ts
// agent: request_human input { reason: "asked_for_person" | "refund_or_return" | "cancellation" | "complaint" | "tool_failure" | "not_sure" | "other";
//                              summary: string (≤ 600, written by the model: what the shopper wants and what was tried) }
//        → ctx.handoff.request({ reason, summary }) returns { opened: true, expectedResponse: <from store facts> }; UI part { type: "handoff", status: "requested" }
// HandoffPort on ToolContext (engine-implemented): request(input) → creates the handoff once per open conversation (idempotent).
// engine handoff/service.ts
export function openHandoff(deps, ctx: { tenantId; conversationId }, input): Promise<{ id: string; created: boolean }>;
export function claimHandoff(deps, tenantId, handoffId, staffName): Promise<"claimed" | "already_claimed" | "not_found">;
export function staffReply(deps, tenantId, handoffId, staffName, text): Promise<"sent" | "not_found" | "not_claimed_by_you">;
export function handBack(deps, tenantId, handoffId): Promise<void>;          // conversation → open, bot resumes next turn
export function resolveHandoff(deps, tenantId, handoffId): Promise<void>;   // conversation → closed
// triggers.ts: session counters { consecutiveToolFailures, consecutiveKnowledgeMisses } updated after each turn; at 2 → offer handoff
//              (UI part { type: "handoff_offer" } with a button posting the UI action `request_handoff`) — the shopper's click opens it.
// staff API (Bearer st_<tenantId>.<secret>, tenant from the token, RLS via withTenant):
//   GET  /staff/v1/handoffs?status=open|claimed|resolved&cursor=   → [{ id, conversationId, reason, summary, status, createdAt, claimedBy }]
//   GET  /staff/v1/handoffs/:id                                   → handoff + display messages (text and UI parts only, no tool payloads)
//   POST /staff/v1/handoffs/:id/claim | /reply { text ≤ 2000 } | /hand-back | /resolve
// admin: POST /admin/tenants/:tenantId/staff-tokens { name } → { token } once; DELETE …/staff-tokens/:id; PUT …/settings { handoffEmails, contactInfo, … }
```

Chat route when `conversation.status = "handoff"`: the shopper message is appended (kind `user`), the SSE stream emits `handoff { status: "claimed" | "waiting" }` and `done`, and **the model is not called** (no cost, no reply).

- [x] **Step 1: Failing tests.**
  - `request_human` creates exactly one open handoff per conversation (second call returns the same id, `created: false`); the summary is stored through `redactPii`; the conversation becomes `handoff`.
  - **Review Focus 4:** while `handoff`, a shopper message never calls the model (spy) and is stored for staff; staff reply is appended as `kind: "staff"` and appears in `GET /v1/conversations/:id`; two staff claiming at once → one `claimed`, one `already_claimed`; reply by a different staff name before claim → `not_claimed_by_you`; hand-back while no turn is leased resumes the bot on the next message; tenant A's staff token on tenant B's handoff → 404 with no data; revoked or malformed token → 401.
  - Notification: `handoff.notify` sends one Brevo email per handoff to every address in `handoffEmails` (subject and body contain the reason, the redacted summary, and a dashboard link — **not** the transcript); a retried job does not send twice (`notified_at`); no addresses configured → logs a warning and completes; a `NotifyError("unavailable")` rethrows for retry, `rejected` completes with a logged error code.
  - Triggers: two failing tool results in a row → `handoff_offer` part; a successful turn resets; two knowledge misses → offer; the click action opens the handoff with reason `tool_failure` / `not_sure`.
  - Prompt snapshot: refund, cancellation and return requests, an explicit ask for a person, and a complaint all call `request_human`; the model never promises an outcome or a time other than the configured expectation.
- [x] **Step 2: Evals** (10 cases × four languages: asks for a person, refund, cancellation, angry complaint, "is a human there?", repeated tool failure, a normal question that must NOT hand off). Deterministic parts pass; live scoring is owner-gated.
- [x] **Step 3: Implement; ADR-011** (states, silence in code, polling, staff tokens, no transcript in email). `pnpm lint`, all 13 package typechecks and all 22 strict PostgreSQL test tasks passed on 2026-10-14; engine and worker production builds passed. Live scoring remains owner-gated. Commit `feat(engine): human handoff, staff API and email alerts`.

### Task 7: Widget — verification, identity and handoff

**Files:** Create `packages/widget/src/ui/{verify,handoff}.tsx`. Modify `src/{host,api,state,config}.ts`, `src/ui/{App,cards}.tsx`, `src/styles.ts`, `e2e/widget.e2e.ts`, tests.

- [x] **Step 1: Failing tests.**
  - `ACE.setIdentity(token | null)` (also queued before load); the token is sent as `identityToken` on chat requests and never stored in `localStorage` or `sessionStorage`; `setIdentity(null)` clears it.
  - `verification_form` part renders a channel choice, a destination field, a "Send code" button, then a 6-digit code field; posts `verify_start` / `verify_confirm`; shows the masked destination, "wrong code" (with remaining attempts not revealed), "locked, try later" and "try again in N minutes"; focus moves to the code field after sending; the code field uses `inputmode="numeric"` and `autocomplete="one-time-code"`; on success the form shows "Verified" and sends no extra chat message, because the identity is already stored server-side and the next turn picks it up.
  - Handoff: `handoff` part shows "A team member will reply here"; while `status = handoff` the widget polls `GET /v1/conversations/:id` every 5 s (stops when closed or the panel is hidden), renders `staff` messages with a "Team" label, and shows "Back with the assistant" after hand-back; the composer stays enabled and messages go to the same chat endpoint.
  - Consent: the existing consent step now also posts the consent record (Task 9 endpoint) when first given; text uses the tenant's `privacyNoticeUrl` returned by the conversation or config response.
  - Accessibility: new regions use `aria-live="polite"`, buttons are keyboard operable, Sinhala and Tamil strings render with the existing font stack. Bundle stays under the 60 kB gzip budget (assert in the build test).
- [x] **Step 2: Implement; checks; e2e (Playwright, `CHROME_PATH` as in AGENTS.md).** The e2e uses the log notifier and reads the code from the engine's log-only outbox endpoint that exists **only when `NODE_ENV !== "production"`** (`GET /v1/dev/outbox?conversation=`; refuses in production, tested). The 35 widget tests, 158 engine tests (one real-platform skip), strict 22-task suite, all 13 typechecks, lint, engine/worker builds and three Chromium e2e flows passed on 2026-10-14; the widget is 14.8 kB gzipped. Commit `feat(widget): verification form, host identity and handoff states`.

### Task 8: `apps/dashboard` — minimal staff inbox

**Files:** Create `apps/dashboard/` (Next.js App Router: `app/login`, `app/inbox`, `app/handoffs/[id]`, `lib/staff-api.ts`, `middleware.ts`) with tests; modify `turbo.json`, `package.json` workspaces if needed, `.github/workflows/ci.yml` (build job), `docker-compose.yml` (service `dashboard`, behind Caddy at `dashboard.<domain>`), `deploy/Caddyfile`.

- [x] **Step 1: Failing tests (Vitest + React Testing Library).** `staff-api` sends `Authorization: Bearer <token>` from the cookie and maps 401 to a redirect to `/login`; login stores the token only in an HttpOnly, `SameSite=Strict`, `Secure` (non-dev) cookie through a route handler and never in client JS; inbox lists open handoffs, newest first, with reason, redacted summary and age; the detail page renders the transcript text, claim, reply, hand back and resolve actions with optimistic disabling to prevent double sends; XSS: message text containing `<script>` renders as text; CSRF: mutating route handlers require `Origin` to match the dashboard host.
- [x] **Step 2: Implement; checks; `next build`.** Language: English UI; Sinhala/Tamil message text displays correctly. Next.js 16's supported `proxy.ts` convention replaces the planned deprecated `middleware.ts`. Nine dashboard tests, all 14 workspace typechecks, the 23-task strict test suite, lint and the production Next build passed on 2026-10-16. The dashboard image build is enforced in CI; Docker was unavailable for a local image build. Commit `feat(dashboard): staff inbox for handoffs`.

### Task 9: PDPA — consent, per-merchant retention, export and deletion

**Files:** Create `apps/engine/src/routes/{consent,privacy}.ts`, `apps/worker/src/handlers/{shopper-export,shopper-delete}.ts`, `packages/db/src/repos/privacy.ts` extensions, `docs/legal/dpa-template.md`, `docs/runbooks/breach.md`, `docs/runbooks/provider-retention.md`. Modify `apps/worker/src/handlers/retention.ts`, `packages/db/src/shopper-data.ts`, `apps/engine/src/routes/admin.ts`.

**Interfaces — Produces:**

```ts
// consent: POST /v1/consent { noticeVersion: string } (conversation token) → 204; idempotent per conversation; when
//   tenant_settings.requireConsent is true, POST /v1/chat on a NEW conversation without a prior consent record → 409 consent_required.
// retention (worker): per tenant: effective = clamp(tenant_settings.retention) over SHOPPER_DATA_TABLES defaults; verifications by otpHours.
// admin privacy API
//   POST /admin/tenants/:t/privacy/export { email? | phone? | conversationId? } → 202 { requestId }; job writes the bundle (JSON: conversations,
//        display messages, handoffs summaries, consent records, verification timestamps) retrievable once via GET …/privacy/requests/:id/download (expires 24 h)
//   POST /admin/tenants/:t/privacy/delete { email? | phone? | conversationId? } → 202 { requestId }; job deletes every shopper-data row for the subject
//   POST /admin/tenants/:t/privacy/offboard → 202; deletes ALL shopper data of the tenant (keeps billing facts and attributed_orders)
//   GET  /admin/tenants/:t/privacy/requests → receipts { id, type, status, counts, requestedAt, completedAt } (no PII)
// subject resolution: email/phone → normalise (Task 1) → identityHash → conversations.identity_hash; conversationId → that conversation.
```

- [x] **Step 1: Failing tests.**
  - Consent: recorded once; refused-consent path returns 409 and creates no conversation; a second consent is a no-op.
  - Retention: tenant A with `messagesDays: 30` has 40-day-old messages purged while tenant B (default 180) keeps its 40-day-old rows; out-of-range settings are clamped; `otpHours: 1` purges two-hour-old verifications; billing tables untouched.
  - **Review Focus 5:** seed one shopper across conversations (verified by email in one, by phone in another with the same visitor), handoffs with sealed contact, consents, verifications, tool calls, traces, queued jobs mentioning the conversation: delete by email removes the email-verified conversation and everything attached; delete by phone likewise; a conversation of a **different** shopper on the same visitor id is **not** deleted unless it has the same identity hash (and the receipt says how many conversations matched); a second run is a no-op with zero counts; `offboard` leaves no row in any `SHOPPER_DATA_TABLES` table for that tenant and does not touch another tenant; pending `handoff.notify` and `sync.*` jobs for deleted conversations complete harmlessly.
  - Export: contains only the subject's rows; never includes another conversation's messages or any other shopper's contact data; the download link works once and expires; the bundle contains no tool payloads or traces.
  - Receipts and logs hold counts only.
- [x] **Step 2: Docs** (written, not code): `dpa-template.md` (processor/controller roles, subprocessors list: LLM providers, Brevo, text.lk, hosting; retention table; deletion SLAs; breach notification duty and timeline); `breach.md` (detect → contain → assess → notify controllers → record), `provider-retention.md` (a checklist of the data-retention and training-opt-out settings to confirm per provider account; **unchecked until the owner verifies**).
- [x] **Step 3: Implement; checks.** First-chat consent is carried as `consentNoticeVersion` so conversation creation and the consent record commit atomically; the token-authenticated consent endpoint remains idempotent for later notice versions. On 2026-10-16 lint, all 14 workspace typechecks, all 23 strict PostgreSQL test tasks, engine/worker/dashboard/widget production builds, and all three Chromium widget e2e flows passed. Commit `feat(privacy): consent records, per-merchant retention, export and deletion`.

### Task 10: Exit verification and docs

**Files:** Modify `AGENTS.md` (status, commands, layout: `notify`, `dashboard`), `docs/workflow.md` (§G identity, §H handoff, §K retention), `docs/superpowers/plans/2026-10-08-roadmap.md` (Phase 7 status), this plan (checkboxes), `scripts/dev-stack.sh` / `store-stack.sh` (dashboard + notifier log mode), `apps/engine/src/seed.ts` (demo tenant settings and a staff token printed once).

- [x] **Step 1: Security suite.** `apps/engine/src/security/order-access.test.ts` collects the Review Focus 1 and 3 cases in one file and is named in AGENTS.md as a release gate. It passed against strict PostgreSQL on 2026-10-16.
- [x] **Step 2: Local end-to-end** (`scripts/dev-stack.sh start`, log notifier). Observed in Chromium on 2026-10-16: asking for `ACE-1001` rendered the verification form; the dev-outbox code verified the shopper; the shipped order card appeared; a refund request created a handoff; staff signed in, claimed it and replied in the dashboard; the reply appeared in the widget; the admin deletion request completed with a receipt reporting one deleted conversation. All four widget browser tests passed.
- [ ] **Step 3 (owner-gated):** real delivery with the Task 3 smoke script; the provider retention checklist; live evals for order support and handoff.
- [x] **Step 4:** On 2026-10-16, `pnpm lint:fix`, lint, all 14 workspace typechecks and all 23 strict PostgreSQL test tasks passed. The engine ran 167 tests with one expected real-platform skip; engine, worker, dashboard and widget production builds passed, and the widget remained 14.8 kB gzipped. Commit `docs: Phase 7 status, workflow and commands`.

## Phase 7 exit checklist

- [x] An order cannot be read without verification: the security suite passes (Task 10 Step 1).
- [x] Deletion removes all of a shopper's data (and `offboard` all of a tenant's), shown by receipts (Task 9).
- [x] Per-merchant retention periods are honoured by the purge (Task 9).
- [x] In local log-notifier mode, a handoff alert is emitted, a human reply reaches the shopper, and the bot stays silent meanwhile (Tasks 6, 8 and 10). Real email delivery remains owner-gated below.
- [ ] Order-support and handoff evals pass with live models (**owner-gated**; deterministic parts green in CI).
- [ ] Real SMS and email delivery confirmed with text.lk and Brevo accounts (**owner-gated**).
- [ ] DPA template, breach runbook and provider retention checklist exist; the checklist is verified (**owner-gated**).
- [x] ADR-010 and ADR-011 written.
- [x] `pnpm lint && pnpm typecheck && pnpm test` green, including db, engine, worker, widget and dashboard.
