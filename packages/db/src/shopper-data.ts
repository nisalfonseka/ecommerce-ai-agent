/**
 * Tables that hold shopper data, with default retention (AGENTS.md: never store shopper data without
 * registering it for the purge and export jobs, which arrive in Phases 6–7). Defaults from workflow §K;
 * tenants may shorten them. usage_ledger is not listed: it holds billing counts only.
 */
export const SHOPPER_DATA_TABLES: readonly { table: string; retentionDays: number }[] = [
  { table: "conversations", retentionDays: 180 },
  { table: "messages", retentionDays: 180 },
  { table: "tool_calls", retentionDays: 30 },
  { table: "turn_traces", retentionDays: 30 },
];
