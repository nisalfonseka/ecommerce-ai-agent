# ADR-011: Human handoff and staff access

- Status: Accepted (2026-10-14). Implementation: Phase 7 Task 6.

## Context

The assistant cannot perform refunds, returns, cancellations or other actions that need merchant judgment. A
shopper must be able to request a person without the model continuing to answer, while merchant staff need a
small tenant-isolated API that does not depend on the internal admin credential. Handoff alerts must not turn
email into another copy of the shopper transcript.

## Decision

### States and model silence

A handoff moves `open` to `claimed` to `resolved`; an open handoff can also be resolved without a claim. A
partial unique index permits only one unresolved handoff per conversation, making repeated model calls and
double clicks idempotent. Opening one sets the conversation to `handoff`.

While a conversation is in `handoff`, the normal chat endpoint stores the shopper's message and emits only the
handoff state plus `done`. It does not call a model or generate an assistant reply. Staff messages are stored as
`kind = staff` with a display-only Team message. Hand-back resolves the current handoff and reopens the
conversation; resolve closes it. A transition that races an active model lease rolls back rather than changing
ownership during a turn.

The widget polls the display transcript while a human owns the conversation. Polling is deliberately chosen
for the first staff inbox because it reuses the authenticated conversation read path and avoids another
long-lived connection protocol. Task 7 fixes the interval at five seconds and stops it when hidden or closed.

### Tool and automatic offers

`request_human` receives a bounded reason and a redacted summary, but tenant and conversation identity come
only from `ToolContext`. Refunds, returns, cancellations, complaints and explicit requests for a person use the
tool. The assistant can repeat only the configured support expectation and cannot promise an outcome or invent
a response time.

Two consecutive tool failures or two consecutive knowledge misses add a deterministic handoff offer. A
successful turn resets the counters. The shopper's button click, not model prose, opens the handoff.

### Staff tokens and tenant boundaries

Staff API tokens have the form `st_<tenantId>.<random secret>`. The full token is returned once; only its SHA-256
hash, a short prefix and the staff name are stored. The tenant id selects the RLS context, then the hash must
match one active, non-revoked row in that tenant. Malformed and revoked tokens receive 401. A valid token for
tenant A receives the same 404 for tenant B's handoff as for an unknown id.

Claim is one guarded database update, so concurrent staff produce one winner. Only that token's staff name may
append a reply. Staff APIs return display messages only; model tool payloads are never included.

### Alerts

Opening a handoff enqueues `handoff.notify`. The worker sends one Brevo email to each configured merchant
address containing only the reason, already-redacted summary and dashboard link. It never includes the
transcript or shopper contact. `notified_at` makes a completed retry a no-op. Provider unavailability is thrown
for pg-boss retry; a permanently rejected destination is logged by code only and the job completes.

## Consequences

- Merchant staff must protect and rotate staff tokens like API credentials; revocation takes effect on the
  next request.
- Polling can add read load for large teams. A measured need is required before adding WebSockets or Redis.
- A process crash after one of several recipient emails succeeds but before `notified_at` may repeat that email
  on retry. Per-recipient delivery receipts would be needed for exactly-once multi-recipient delivery.
- An empty recipient list does not block handoff: the worker warns and completes, while staff can still use the
  inbox.
