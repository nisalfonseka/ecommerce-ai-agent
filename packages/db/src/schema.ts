import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** RLS on tenants matches `id`; every other table matches `tenant_id` (see migrations/*_rls.sql). */
export const tenants = pgTable("tenants", {
  id: id(),
  name: text("name").notNull().unique(),
  status: text("status").notNull().default("active"),
  createdAt: createdAt(),
});

const tenantId = () =>
  uuid("tenant_id")
    .notNull()
    .references(() => tenants.id);

export const stores = pgTable("stores", {
  id: id(),
  tenantId: tenantId(),
  platform: text("platform").notNull(),
  currency: text("currency").notNull(),
  config: jsonb("config").notNull().default({}),
  /** sealSecret() output; never selected outside the provider factory. */
  credentialsSealed: bytea("credentials_sealed"),
  createdAt: createdAt(),
});

export const bots = pgTable("bots", {
  id: id(),
  tenantId: tenantId(),
  storeId: uuid("store_id")
    .notNull()
    .references(() => stores.id),
  persona: jsonb("persona").notNull(),
  storeFacts: jsonb("store_facts").notNull(),
  model: text("model").notNull(),
  cheapModel: text("cheap_model").notNull(),
  fallbackModel: text("fallback_model"),
  /** Integer micro-dollars (1e-6 USD); not shopper-facing money. */
  budgetSoftUsdMicros: integer("budget_soft_usd_micros").notNull(),
  budgetHardUsdMicros: integer("budget_hard_usd_micros").notNull(),
  maxSteps: integer("max_steps").notNull().default(8),
  createdAt: createdAt(),
});

export const widgetKeys = pgTable("widget_keys", {
  id: id(),
  tenantId: tenantId(),
  botId: uuid("bot_id")
    .notNull()
    .references(() => bots.id),
  /** sha256 hex of the publishable key; the key itself is never stored. */
  keyHash: text("key_hash").notNull().unique(),
  keyPrefix: text("key_prefix").notNull(),
  allowedOrigins: text("allowed_origins").array().notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/**
 * Routing copy of widget_keys for the one lookup that happens before the tenant is known.
 * No RLS and no grants to the app role; read only through resolve_widget_key() (ADR-005).
 */
export const widgetKeyLookup = pgTable("widget_key_lookup", {
  keyHash: text("key_hash").primaryKey(),
  tenantId: uuid("tenant_id").notNull(),
  botId: uuid("bot_id").notNull(),
  allowedOrigins: text("allowed_origins").array().notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const conversations = pgTable("conversations", {
  id: id(),
  tenantId: tenantId(),
  botId: uuid("bot_id")
    .notNull()
    .references(() => bots.id),
  channel: text("channel").notNull().default("web"),
  visitorId: text("visitor_id").notNull(),
  session: jsonb("session").notNull(),
  cartId: text("cart_id"),
  summary: text("summary"),
  /** Turn lease: a turn owns the conversation until this time (see acquireTurnLease). */
  busyUntil: timestamp("busy_until", { withTimezone: true }),
  status: text("status").notNull().default("open"),
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
});

export const messages = pgTable(
  "messages",
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    /** "model": an AI SDK ModelMessage; "action": a deterministic UI action event. */
    kind: text("kind").notNull(),
    payload: jsonb("payload").notNull(),
    /** What GET /v1/conversations/:id shows: text and UI parts, never tool payloads. */
    display: jsonb("display"),
    createdAt: createdAt(),
  },
  (t) => [unique("messages_conversation_seq").on(t.conversationId, t.seq)],
);

export const toolCalls = pgTable("tool_calls", {
  id: id(),
  tenantId: tenantId(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  turnId: text("turn_id").notNull(),
  name: text("name").notNull(),
  inputRedacted: jsonb("input_redacted"),
  outputRedacted: jsonb("output_redacted"),
  ok: boolean("ok").notNull(),
  errorCode: text("error_code"),
  ms: integer("ms").notNull(),
  createdAt: createdAt(),
});

export const turnTraces = pgTable("turn_traces", {
  id: id(),
  tenantId: tenantId(),
  conversationId: uuid("conversation_id")
    .notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  turnId: text("turn_id").notNull(),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  costUsdMicros: integer("cost_usd_micros"),
  latencyMs: integer("latency_ms").notNull(),
  toolNames: text("tool_names").array().notNull(),
  outcomes: text("outcomes").array().notNull(),
  regenerated: boolean("regenerated").notNull(),
  ungroundedCount: integer("ungrounded_count").notNull(),
  error: text("error"),
  createdAt: createdAt(),
});

/** Billing facts only (no shopper content), so it is kept when conversations are purged. */
export const usageLedger = pgTable("usage_ledger", {
  id: id(),
  tenantId: tenantId(),
  botId: uuid("bot_id")
    .notNull()
    .references(() => bots.id),
  turnId: text("turn_id").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull(),
  outputTokens: integer("output_tokens").notNull(),
  costUsdMicros: integer("cost_usd_micros"),
  createdAt: createdAt(),
});

export const idempotencyRecords = pgTable(
  "idempotency_records",
  {
    id: id(),
    tenantId: tenantId(),
    storeId: uuid("store_id").notNull(),
    operation: text("operation").notNull(),
    target: text("target").notNull(),
    key: text("key").notNull(),
    fingerprint: text("fingerprint").notNull(),
    status: text("status").notNull(),
    result: jsonb("result"),
    reconcile: jsonb("reconcile"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().default(sql`now()`),
  },
  (t) => [unique("idempotency_scope").on(t.tenantId, t.storeId, t.operation, t.target, t.key)],
);

/** Tables guarded by `tenant_id` (tenants itself is guarded by `id`). The RLS test iterates this list. */
export const TENANT_TABLES = [
  "stores",
  "bots",
  "widget_keys",
  "conversations",
  "messages",
  "tool_calls",
  "turn_traces",
  "usage_ledger",
  "idempotency_records",
] as const;
