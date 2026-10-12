# ADR-007: Cash-on-delivery confirmation by UI action

- Status: Accepted, provisional, owner review welcome (2026-10-09). Implementation: Phase 5 Task 9.
- Deviates from: spec G5 and workflow §E, which proposed AI SDK tool approval (`toolApproval`) with a server-bound approval secret.

## Context

AGENTS.md rule 7: placing a COD order needs an explicit, server-verified confirmation from the shopper. With tool approval, the model holds an order-placing tool, and the engine must persist the pending call between requests and bind the approval to it. The engine stores conversation history as messages, not as resumable model state. A mistake in that binding lets a crafted message, or the model itself, place an order.

## Decision

- **The model never holds a tool that places an order.**
  - The model's only COD tool is `start_cod_order`. It takes no input and shows a `delivery_form` card.
  - It is offered only when the store declares `orders.place_cod` and the bot enables COD (`storeFacts.cod.enabled`).
- **The shopper's details come from the form, never from chat.**
  - The form posts the UI action `cod_quote`. The engine validates the details (`CodDetailsSchema`: phone normalised to E.164), applies the COD rules in code (allowed cities, `maxTotal`), and asks the store for a quote (`quoteCodOrder`, delivery fee included).
  - It keeps a `codDraft` in the conversation session and returns a `cod_summary` card with **Confirm** and **Edit**.
- **Confirm is the approval.**
  - Clicking it posts the UI action `place_cod_order`, authenticated by the conversation token, with the click's `actionId` as the idempotency key.
  - The engine re-quotes first. If the total or item count changed, it shows a new summary instead of placing the order.
  - Otherwise it calls `placeCodOrder`, clears the draft, and returns the `order` card.
  - A retried Confirm returns the same order, and a double click places one order (ADR-002).
- Both actions exist only in `ACTION_TOOLS`, which `buildTools` never gives to the model.
- **Personal data.**
  - Delivery details live only in the session draft (conversation retention, export and purge) until the order is placed.
  - Tool-call records and action summaries say "(delivery details)" instead of the values.
  - The next chat turn learns only the order number.

## Consequences

- No model output can place an order, so there is no approval state to forge. Approval is a deterministic, authenticated click on a summary the store priced.
- Other channels (WhatsApp, Phase 10) need an equivalent confirmation step: for example a reply button carrying a one-time token.
- Phone verification by OTP for COD (workflow §E step 2, "if the tenant requires it") waits for Phase 7 identity.
- If the owner prefers AI SDK tool approval, only the agent tools and the engine route change. The contract (`quoteCodOrder`, `placeCodOrder`) and the widget cards stay.
