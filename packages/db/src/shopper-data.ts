/**
 * Tables that hold shopper data, with default retention (AGENTS.md: never store shopper data without
 * registering it for the purge and export jobs, which arrive in Phases 6–7). Defaults from workflow §K;
 * tenants may shorten them. usage_ledger and attributed_orders are not listed: they hold billing facts only.
 * MERCHANT_CONTENT_TABLES are not listed either (see there).
 */
export const SHOPPER_DATA_TABLES: readonly { table: string; retentionDays: number }[] = [
  { table: "conversations", retentionDays: 180 },
  { table: "messages", retentionDays: 180 },
  { table: "tool_calls", retentionDays: 30 },
  { table: "turn_traces", retentionDays: 30 },
  { table: "webhook_events", retentionDays: 30 },
];

/**
 * Merchant content, not shopper data: the purge and the shopper export skip these. Knowledge documents are the
 * merchant's own policies, FAQs and size guides (uploaded through the admin API, never written from a chat),
 * so they hold no shopper's personal data and live until the merchant deletes them.
 */
export const MERCHANT_CONTENT_TABLES: readonly string[] = ["knowledge_documents", "knowledge_chunks"];
