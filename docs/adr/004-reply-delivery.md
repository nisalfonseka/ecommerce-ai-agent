# ADR-004: Reply delivery — status events, then the validated reply

- Status: **Provisional** (2026-10-09). Implemented with the plan's recommendation for decision E1 while the owner has not answered; revisit when E1 is decided or staging latency is measured.
- Implementation: Phase 3 Task 7 (`apps/engine/src/routes/chat.ts`, `turn.ts`).

## Context

The spec asks for two things that conflict. Workflow §C7: amounts and links in the reply must be checked against tool results before the shopper sees them. §4.7: p95 time to first token under 2 s. Streaming model tokens live shows prices before they can be checked. Buffering the whole reply makes the first visible text wait for the full turn: several tool calls plus a possible regeneration.

## Decision

`POST /v1/chat` answers with Server-Sent Events in this order:

1. `conversation` — `{ conversationId, conversationToken }`, sent immediately.
2. `status` — `{ tool }` each time a tool starts ("Searching dresses…"), so the widget shows progress within a second or two.
3. `reply` — `{ text, ui, cartId }`, sent once, after the grounding check (and at most one regeneration). Ungrounded amounts that survive are replaced with `[see the product card]`. UI parts still carry the real prices.
4. `done`, or `error` — `{ code, message }` in place of `reply`.

Failures decided before the turn starts (invalid input, unknown or foreign conversation, concurrent turn, rate limit) are plain HTTP errors (400 / 404 / 409 / 429). They are never sent as SSE.

## Consequences

- No unchecked price ever reaches the shopper. The first *answer text* waits for the whole turn, but the first *visible feedback* (a status line) does not.
- Measure on staging: time to first `status` and time to `reply`. If shoppers find the wait too long, the next option is sentence-level streaming, holding back any sentence that contains an amount or link until it is checked.
- The widget (Phase 4) renders `status` as a transient line and replaces it with the reply.
