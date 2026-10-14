# ADR-010: Shopper identity and one-time-code verification

- Status: Accepted (2026-10-14). Implementation: Phase 7 Task 4.

## Context

Order support needs proof that the shopper owns an email address, phone number, or authenticated host-store
account. The model must never create identity, accept a typed email as proof, or receive a one-time code. The
system also needs rate limits that prevent code guessing and notification pumping without revealing whether a
destination has an order.

## Decision

### Domain-separated hashes and encrypted destinations

`ACE_MASTER_KEY` derives two 32-byte keys with HKDF-SHA256:

- `ace/otp/v1` hashes `salt || code` before the code is stored.
- `ace/identity-hash/v1` hashes tenant id, identifier kind and normalized identifier. Including the tenant and
  kind prevents cross-tenant correlation and prevents an email value being interpreted as a phone identity.

Verification rows store the destination HMAC for rate limits and an envelope-encrypted normalized destination.
The encrypted value is necessary because confirmation receives only the code, while a successful
`VerifiedIdentity` must contain the exact address or number proved by delivery. It is opened only after a
constant-time code comparison succeeds and is deleted by OTP retention. The code itself is never stored.

### OTP lifecycle

- Codes contain six unbiased random digits and expire after 10 minutes.
- Starting a code invalidates every earlier pending code for that conversation. PostgreSQL advisory locks make
  the count-and-create path atomic for the conversation and destination.
- Defaults allow three starts per destination per hour, five per conversation per hour, and twenty per IP per
  hour. SMS also has a tenant country-code allow-list (Sri Lanka only by default).
- Every comparison is between fixed-length HMAC digests using `timingSafeEqual`. After five failed comparisons,
  the sixth submission locks without comparing; a consumed code cannot be replayed.
- The verification row and notification send share a database transaction. A provider failure rolls the row
  back, so an unsent code never remains pending.
- Start does not query orders or customers. Its behavior therefore cannot reveal whether the destination is
  known. Provider errors are reduced to `unavailable` and never contain the destination or message body.

Successful confirmation stores only the identity method and the one contact that delivery proved. The raw
identity is usable for 30 minutes; `identity_hash` remains as the privacy export/deletion lookup key. An action
message records that verification occurred but contains no contact or code.

### Host sessions

A tenant may rotate a random 32-byte host-session secret through the admin API. The secret is envelope-encrypted
at rest and returned only by the rotation response. The host signs an HS256 token containing `sub`, `exp`, and
optional email/phone claims with explicit verified flags.

The engine accepts only a non-empty subject, an unexpired token, and an expiry no more than 24 hours ahead.
Unverified contact claims are dropped. Bad signatures, malformed claims, expiry, and another tenant's secret all
produce the same anonymous result. A host identity applies to that request only and is never persisted on the
conversation.

## Consequences

- Rotating a host-session secret immediately invalidates existing tokens; the host application must switch to
  the new secret at the same time.
- Notification delivery occurs while a short database transaction is open. This is intentional for rollback
  correctness; provider timeouts are bounded by the notifier clients.
- Changing either HKDF label invalidates existing hashes or codes and therefore requires an explicit migration
  or a temporary multi-version verifier.
- Development may use the masked log notifier. Production requires configured text.lk and Brevo credentials;
  log notification mode is rejected in production.
