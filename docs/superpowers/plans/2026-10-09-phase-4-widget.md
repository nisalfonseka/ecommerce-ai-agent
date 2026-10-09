# Phase 4 — Chat Widget Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** In progress (2026-10-09). The owner asked to continue while Phase 2's live evals and Phase 3's staging deployment wait for API keys and a VPS. Everything here runs locally against the engine with the keyless demo model.

**Goal:** One script tag adds a chat assistant to any store website. Shoppers find products by chatting, choose a size on a product card, add to the store's own cart, see the site's cart badge update, and go to checkout.

**Architecture:** `@ace/widget` is a Preact app mounted in a Shadow DOM (so host CSS cannot break it, and its CSS cannot break the host), bundled by esbuild into one `ace.js`. A small client core (config from the script tag, storage, an API client that reads the engine's SSE stream with `fetch`) has no UI dependencies and is unit-tested on its own. Every price, image, stock badge and checkout link comes from engine UI parts, never from model text (AGENTS.md rule 14). Card buttons call `POST /v1/actions/:type` with a fresh `actionId`.

**Tech Stack:** Preact 10/11, esbuild, TypeScript (JSX via `preact`), Vitest + happy-dom (unit and render tests), Playwright with the preinstalled Chromium (end-to-end).

**Spec:** §3 G2 (cart sync), G6/G14 (UI from tool data), J7 (deterministic actions); §4.3 structured UI parts; workflow §C (actions), §D. Roadmap Phase 4. ADR-004 (SSE events).

## Global Constraints

- Phase 1–3 constraints apply. The widget imports **types only** from `@ace/agent` / `@ace/contracts` (erased at build), so no Zod or SDK code reaches the browser bundle.
- **Bundle budget:** `dist/ace.js` ≤ 60 kB gzipped. The build fails above it.
- **No secrets in the browser:** only the publishable widget key, the conversation token (a bearer for one conversation) and a random visitor ID. All browser storage access is wrapped in try/catch (private mode); the widget works without storage.
- **Text from the model is rendered as text**, never as HTML. Links come only from UI parts.
- **Accessibility:** a real `<button>` launcher with an accessible name; the dialog has `role="dialog"` and a label; Esc closes it; the message list is `aria-live="polite"`; everything is reachable by keyboard.
- **Language:** the system font stack plus `"Noto Sans Sinhala"` and `"Noto Sans Tamil"` fallbacks (no web-font download in the bundle; hosts may load them).
- Not in this phase: identity (`ACE.setIdentity`, Phase 7), WhatsApp (Phase 10), handoff UI (Phase 7).

## Review Focus

1. **XSS:** product titles, descriptions and model replies containing `<img onerror>` or `javascript:` links render as inert text. Checkout and product links must be `https:` (or `http:` for local development only).
2. **Double add:** a double click on "Add" sends one `actionId`, so the engine adds once.
3. **Resume:** reloading the host page restores the conversation (token in storage) and the next message continues it; a 404 for an expired or foreign conversation starts a new one cleanly.
4. **Cart sync:** every reply or action that changes `cartId` or the cart fires `ace:cart-updated` on `window` with `{ cartId, itemCount }`.

---

## File Structure

```text
packages/agent/src/ui.ts, tools/catalog.ts              # Task 1 (modify): variants on product_list items
packages/widget/
  package.json, tsconfig.json, build.mjs                # Task 2: esbuild + size budget
  src/config.ts        (+ .test.ts)                     # Task 3: read data-key / data-api from the script tag
  src/storage.ts       (+ .test.ts)                     # Task 3: safe localStorage, visitor id, saved conversation
  src/sse.ts           (+ .test.ts)                     # Task 3: parse an SSE byte stream into events
  src/api.ts           (+ .test.ts)                     # Task 3: chat (streaming), action, loadConversation
  src/money.ts         (+ .test.ts)                     # Task 3: minor units → "LKR 18,500.00"
  src/host.ts          (+ .test.ts)                     # Task 4: window.ACE, ace:cart-updated
  src/state.ts         (+ .test.ts)                     # Task 5: conversation state machine (pure)
  src/ui/*.tsx         (+ .test.tsx)                    # Task 5: launcher, panel, messages, cards, consent
  src/styles.ts                                         # Task 5
  src/main.tsx                                          # Task 5: mount in Shadow DOM
  demo/index.html, demo/server.mjs                      # Task 6: host page with a cart badge
  e2e/widget.e2e.ts                                     # Task 7: Playwright, real engine + Postgres
scripts/dev-stack.sh                                    # Task 6: Postgres + engine (demo model) + demo page
```

---

### Task 1: Variants on product cards (agent, UI only)

The widget needs sizes to add a product from a card. `product_list` items gain `variants: { variantId, title, options, price, availability }[]` (the matching variants, live). This goes to the UI part only; the model's tool output stays compact.

- [x] Failing test in `tools/catalog.test.ts`: the `product_list` item for the linen shirt lists S/M/L with L `out_of_stock`, and the model-facing `data` is unchanged.
- [x] Implement (search results summarise matching variants, so read live variants with `getProduct` per item; at most 5 items). Checks; commit `feat(agent): variant choices on product list cards`.

### Task 2: `@ace/widget` package and build

- [ ] `package.json` (`build`: `node build.mjs`, `test`, `typecheck`), `tsconfig.json` (`jsx: react-jsx`, `jsxImportSource: preact`, DOM lib).
- [ ] `build.mjs`: esbuild IIFE bundle `dist/ace.js`, minified, `target: es2020`. Print the gzipped size and fail above 60 kB.
- [ ] Commit `chore(widget): package and size-budgeted build`.

### Task 3: Client core

Interfaces:
- `readConfig(script: HTMLScriptElement | null): { key: string; api: string } | null` (`data-key="pk_…"`, `data-api="https://…"`; the default API is the script's own origin).
- `createStorage(raw: Storage | null)` → `{ visitorId(): string; loadConversation(key): Saved | null; saveConversation(key, saved); clearConversation(key); consentGiven(): boolean; giveConsent() }`.
- `parseSse(chunks: AsyncIterable<string>): AsyncIterable<{ event, data }>`. It handles events split across chunks.
- `createApi({ api, key, visitorId, fetch })` → `chat({ message, conversationId?, conversationToken?, cartId? }, onEvent)`, `action(type, body)`, `loadConversation(id, token)`. Error JSON becomes a typed `ApiError(status, code)`.
- `formatMoney({ amount, currency })` (same output as the agent's, so text and cards agree).

- [ ] Failing tests:
  - config parsing (missing key → null)
  - storage with a throwing `localStorage`
  - SSE split across chunks
  - chat emits events in order
  - a 409 becomes `ApiError("turn_in_progress")`
  - money formatting
- [ ] Implement; commit `feat(widget): config, storage, SSE and API client`.

### Task 4: Host integration

- `window.ACE = { open(), close(), setCart(cartId: string | null) }`. Calls made before the script loads are queued (`window.ACE = window.ACE || { q: [] }` snippet) and replayed.
- `emitCartUpdated(cartId, itemCount)` → `window.dispatchEvent(new CustomEvent("ace:cart-updated", { detail }))`.

- [ ] Failing tests: queued `setCart` before load is applied; the event fires with the detail. Implement; commit.

### Task 5: UI

- `state.ts`: a pure reducer for the conversation:
  - status: `idle` | `sending` | `error`
  - messages: user / assistant text + UI parts
  - status line
  - conversation id + token
  - cart id
- Components:
  - `Launcher`
  - `Panel` (header, close, `aria-live` list, composer with 2,000-char cap)
  - `Consent` (first open; accept → stored)
  - `ProductCards` (image, title, price or range, stock badge, size buttons → `add_to_cart`; out-of-stock sizes disabled)
  - `CartCard` (lines, −/+ → `update_cart_line`, remove = 0, subtotal, Checkout → `start_checkout`)
  - `CheckoutCard` (a link button with `rel="noopener"`)
  - `OrderCard`
  - `Notice` (verification needed: "Order lookup needs verification, coming soon")
- `main.tsx`: create a host `<div>`, attach a closed Shadow DOM, inject styles, render; restore the saved conversation via `GET /v1/conversations/:id` (404 → clear).

- [ ] Failing render tests (happy-dom):
  - XSS strings render as text
  - a `javascript:` checkout URL is not rendered as a link
  - size buttons disable out-of-stock variants
  - one click → one action with a fresh `actionId`, and buttons are disabled while it runs
  - consent gates the composer
  - a reply updates the cart badge event
- [ ] Implement; checks; bundle under budget; commit `feat(widget): chat panel, product, cart and checkout cards`.

### Task 6: Demo host page and local stack

- `demo/index.html`: a plain store page with a cart badge listening to `ace:cart-updated`, plus the install snippet.
- `demo/server.mjs`: serves `demo/` and `dist/ace.js` on port 5173 (the seed's default origin).
- `scripts/dev-stack.sh`: starts the throwaway Postgres, migrates, seeds (demo model), starts the engine on 8080 (`NODE_ENV=development`), builds the widget, starts the demo server, and prints the URL. `stop` subcommand.
- [ ] Manual check, then commit `feat(widget): demo store page and local dev stack`.

### Task 7: End-to-end test

- `e2e/widget.e2e.ts` (Playwright, Chromium from `/opt/pw-browsers` or the Playwright default). It starts the stack (Postgres via `ACE_TEST_DATABASE_URL`, the engine from source with `tsx`, and the demo server), then:
  1. open the widget
  2. accept consent
  3. ask "black dress"
  4. see a product card
  5. click size M
  6. the cart card shows 1 item and the host badge shows 1
  7. click Checkout and see a checkout link to the memory store's checkout URL
  8. reload the page, and the conversation is restored
- `pnpm --filter @ace/widget e2e`. Not part of `pnpm test` (it needs a browser). A CI job runs it.
- [ ] Commit `test(widget): end-to-end shopping flow in Chromium`.

## Phase 4 exit checklist

- [ ] On the demo page, a shopper finds, adds and checks out (memory adapter) using chat and buttons; the cart badge updates (e2e test).
- [ ] `dist/ace.js` < 60 kB gzipped (build check).
- [ ] Keyboard-only use works; Esc closes; screen-reader labels present (render tests + manual check).
- [ ] `pnpm lint && pnpm typecheck && pnpm test` green; e2e green.
