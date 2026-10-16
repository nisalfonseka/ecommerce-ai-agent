# Production provider retention checklist

Owner verification is required for every production account. Keep every item unchecked until the owner signs in to
the provider console, verifies the current account setting and records dated evidence. Documentation alone is not
account-level proof.

## LLM provider selected for each tenant

- [ ] Record the provider, account/project, model ids, processing region and verification date.
- [ ] Confirm API inputs and outputs are not used for model training under the active account terms.
- [ ] Confirm abuse-monitoring retention and whether a zero-data-retention or equivalent control is enabled.
- [ ] Disable provider-side prompt/history logging where available and document unavoidable retention.
- [ ] Confirm deletion/support procedure, subprocessors and cross-border safeguards.

## Brevo email

- [ ] Confirm transactional logs and message-content retention for the production account.
- [ ] Minimize or disable stored email body content and tracking that is not required.
- [ ] Confirm contact lists are not created by OTP/handoff delivery and document deletion/support procedures.
- [ ] Record account region, subprocessors, DPA link and verification date.

## text.lk SMS

- [ ] Confirm SMS body, destination and delivery-log retention with text.lk for the production account.
- [ ] Confirm OTP messages are not reused for marketing and no contact list is created.
- [ ] Record deletion/support procedure, hosting location, subprocessors, DPA/terms and verification date.

## VPS, PostgreSQL and backups

- [ ] Record the VPS/database region, provider, access list and encryption settings.
- [ ] Confirm database, snapshot and backup retention matches the signed DPA, including deleted-tenant expiry.
- [ ] Test a restore without reactivating expired export bundles or revoked credentials.
- [ ] Confirm log drains, monitoring and support tooling have documented retention and redact personal data.

## Approval

- [ ] The owner attached dated screenshots or provider confirmations for every item above.
- [ ] The DPA subprocessor schedule and backup period match the verified settings.
- [ ] Any exception has an owner, risk decision and review date.
