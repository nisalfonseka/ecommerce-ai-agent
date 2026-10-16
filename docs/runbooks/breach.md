# Personal-data breach runbook

Use this runbook for suspected unauthorized access, disclosure, loss, alteration or destruction of shopper data.
Do not put raw personal data, tokens or secrets in chat, tickets or logs.

## 1. Detect and open the incident

1. Record the reporter, UTC time, affected environment and observable symptoms.
2. Assign an incident lead and a separate note taker. Restrict the incident channel and evidence folder.
3. Preserve relevant counts, request ids, access logs and configuration versions. Do not copy message bodies unless
   the incident lead documents why they are necessary.

## 2. Contain safely

1. Revoke the narrowest affected staff, admin, widget, provider or host-session credential.
2. Isolate the affected tenant or service when necessary; preserve evidence before rebuilding.
3. Stop unauthorized egress and malicious jobs. Do not delete evidence or run a broad database change without a
   reviewed recovery plan.

## 3. Assess

Determine the affected tenants, time window, data categories, approximate subjects and records, attacker access,
encryption state, likely consequences, cross-border providers and whether containment is complete. Use tenant-scoped
queries and report counts, not content. Record assumptions and unknowns.

## 4. Notify controllers

The merchant is the controller and decides regulator and shopper notifications. Notify every affected controller
without undue delay, targeting an initial notice within 24 hours of confirmation. Include what happened, when it was
detected, affected categories and approximate counts, likely consequences, containment already taken, recommended
controller actions, a contact point, and the next update time. Send corrections as facts change; do not wait for a
perfect final report.

## 5. Recover and record

1. Rotate affected credentials, patch the cause, validate tenant isolation, and monitor for recurrence.
2. Restore service in stages and confirm security checks, data integrity, jobs and notifications.
3. Keep the decision log, evidence locations, controller notices, timeline and final impact assessment.
4. Add regression tests and update this runbook, architecture decisions or provider controls.
5. Close only after the incident lead and affected controllers receive the final report and all follow-ups have owners.
