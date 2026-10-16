# Data Processing Agreement template

This template must be reviewed and completed by the merchant and its legal adviser before production use. It is
not a substitute for legal advice.

## Parties and roles

- **Controller:** `[merchant legal name and address]`, which decides why and how shopper data is processed.
- **Processor:** `[service operator legal name and address]`, which operates the commerce assistant only on the
  controller's documented instructions.
- **Effective date and term:** `[date]` until the service agreement ends and deletion is complete.

The processor will process chat messages, verified email addresses or phone numbers, order-support responses,
handoff records, consent records and technical identifiers only to provide, secure and support the service. The
controller is responsible for the privacy notice, lawful basis, shopper requests and instructions to the processor.

## Security and confidentiality

The processor will restrict production access, encrypt credentials and verification destinations, isolate tenants
with PostgreSQL row-level security, avoid payment-card data, keep audit evidence, and require its personnel and
subprocessors to protect confidential data. The controller will protect its admin, staff and provider credentials.

## Subprocessors

The production schedule must name the selected companies, regions and account terms before launch.

| Service | Purpose | Selected provider/account | Location and safeguards |
|---|---|---|---|
| LLM | Generate assistant replies | `[Gemini, OpenAI or Anthropic]` | `[complete before launch]` |
| Email | OTP and handoff delivery | Brevo | `[complete before launch]` |
| SMS | OTP delivery | text.lk | Sri Lanka; `[complete terms]` |
| Hosting and database | Run the application and PostgreSQL | `[VPS provider]` | `[region and safeguards]` |

The processor will notify the controller before adding or replacing a production subprocessor and will flow down
equivalent data-protection obligations.

## Retention and deletion

| Data | Default | Configurable limit | End-of-service action |
|---|---:|---:|---|
| Conversations, display messages and consent records | 180 days | 30–730 days | Delete |
| Tool records, traces and webhook events | 30 days | 7–90 days | Delete |
| Handoff records | 180 days | 30–730 days | Delete |
| OTP verification records | 24 hours | 1–72 hours | Delete |
| One-time privacy export bundle | 24 hours | Fixed | Delete on download or expiry |
| Billing facts and attributed-order totals | Contract/accounting period | `[insert period]` | Retain only as legally required |

Daily tenant-scoped jobs enforce these periods. A subject deletion is targeted by a tenant-specific HMAC or a
conversation id. Offboarding deletes all rows registered as shopper data while preserving only billing facts and
non-shopper merchant configuration. The processor will queue a verified deletion instruction promptly, target
completion within 24 hours, and report per-table counts without shopper content. Backup expiry: `[insert hosting
backup period and restore controls]`.

## Data-subject requests

The controller authenticates the requester and sends an export or deletion instruction through the admin API. The
processor returns a one-time JSON export containing conversations, display messages, handoff summaries, consents
and verification timestamps. It excludes internal tool payloads and traces. The controller remains responsible for
the response to the shopper and any lawful exception.

## Incidents, audits and termination

The processor will notify the controller without undue delay after confirming a personal-data breach, targeting an
initial notice within 24 hours, and will provide known scope, effects, containment and remediation so the controller
can assess its legal notifications. The processor will maintain an incident record and reasonable compliance
evidence. On termination it will run tenant offboarding, provide the counts-only receipt, and delete remaining
backups on the documented hosting schedule unless law requires retention.

Controller: `[name, title, signature, date]`  
Processor: `[name, title, signature, date]`
