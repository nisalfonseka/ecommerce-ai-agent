import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

/** Must match EMBEDDING_DIMENSIONS in the search package; changing it needs a migration and a re-embed. */
const EMBEDDING_DIMENSIONS = 768;

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
  /** sealSecret() output: the HMAC secret that signs this store's inbound webhooks. */
  webhookSecretSealed: bytea("webhook_secret_sealed"),
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

export const conversations = pgTable(
  "conversations",
  {
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
    /**
     * 'open' | 'handoff' | 'closed'. While 'handoff' a human owns the conversation and the engine never calls
     * the model for it (enforced in code, not by the prompt).
     */
    status: text("status").notNull().default("open"),
    /**
     * The verified shopper identity as the engine stored it: the method plus the one verified contact, which is
     * the raw email or phone (order matching needs the value, not a hash). It is short-lived by design: the
     * engine nulls it at `identity_expires_at` and the retention purge clears any expired identity that is left,
     * so raw contact data does not outlive the verification window. `identity_hash` is the long-lived key.
     * Null = anonymous.
     */
    identity: jsonb("identity"),
    /** When `identity` stops counting; an expired identity is treated as no identity. */
    identityExpiresAt: timestamp("identity_expires_at", { withTimezone: true }),
    /** HMAC of the verified email or phone (key derived from the master key): finds a shopper's conversations without raw contact data. */
    identityHash: text("identity_hash"),
    handoffOpenedAt: timestamp("handoff_opened_at", { withTimezone: true }),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [index("conversations_identity_hash").on(t.tenantId, t.identityHash)],
);

export const messages = pgTable(
  "messages",
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    /** "model": an AI SDK ModelMessage; "action": a deterministic UI action event; "staff": a human reply during a handoff. */
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
  /** Null for work that has no bot (enrichment and embedding jobs); then storeId says whose it is. */
  botId: uuid("bot_id").references(() => bots.id),
  storeId: uuid("store_id").references(() => stores.id),
  /** 'turn' | 'enrich' | 'embed' */
  kind: text("kind").notNull().default("turn"),
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

const storeId = () =>
  uuid("store_id")
    .notNull()
    .references(() => stores.id);

/** Search read model: discovery only. Live prices and stock always come from the adapter. */
export const catalogProducts = pgTable(
  "catalog_products",
  {
    id: id(),
    tenantId: tenantId(),
    storeId: storeId(),
    productId: text("product_id").notNull(),
    handle: text("handle").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    url: text("url"),
    category: text("category"),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    /** Product.attributes as the store sent it. */
    platformAttributes: jsonb("platform_attributes").notNull().default({}),
    /** EnrichedAttributes; null until enriched. */
    enriched: jsonb("enriched"),
    overrides: jsonb("overrides").notNull().default({}),
    /** Effective attributes = merge(platform, enriched, overrides); what filters and FTS use. */
    attributes: jsonb("attributes").notNull().default({}),
    imageUrl: text("image_url"),
    currency: text("currency").notNull(),
    minPrice: integer("min_price").notNull(),
    maxPrice: integer("max_price").notNull(),
    availability: text("availability").notNull(),
    /** 'active' | 'deleted' */
    status: text("status").notNull().default("active"),
    hidden: boolean("hidden").notNull().default(false),
    boost: real("boost").notNull().default(0),
    searchPrimary: text("search_primary").notNull(),
    searchSecondary: text("search_secondary").notNull(),
    searchTsv: tsvector("search_tsv").generatedAlwaysAs(
      sql`setweight(to_tsvector('english', search_primary), 'A') || setweight(to_tsvector('english', search_secondary), 'B') || setweight(to_tsvector('english', left(description, 4000)), 'C')`,
    ),
    sourceUpdatedAt: timestamp("source_updated_at", { withTimezone: true }),
    contentHash: text("content_hash").notNull(),
    enrichedHash: text("enriched_hash"),
    enrichmentModel: text("enrichment_model"),
    embeddedHash: text("embedded_hash"),
    embeddingModel: text("embedding_model"),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("catalog_products_scope").on(t.tenantId, t.storeId, t.productId),
    index("catalog_products_status").on(t.tenantId, t.storeId, t.status),
    index("catalog_products_tsv").using("gin", t.searchTsv),
  ],
);

export const catalogVariants = pgTable(
  "catalog_variants",
  {
    id: id(),
    tenantId: tenantId(),
    storeId: storeId(),
    productId: text("product_id").notNull(),
    variantId: text("variant_id").notNull(),
    title: text("title").notNull(),
    options: jsonb("options").notNull().default({}),
    /** Lowercased "name:value" pairs, e.g. {"color:black","size:m"}. */
    optionKeys: text("option_keys").array().notNull().default(sql`'{}'::text[]`),
    price: integer("price").notNull(),
    currency: text("currency").notNull(),
    availability: text("availability").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    unique("catalog_variants_scope").on(t.tenantId, t.storeId, t.variantId),
    index("catalog_variants_product").on(t.tenantId, t.storeId, t.productId),
    index("catalog_variants_option_keys").using("gin", t.optionKeys),
  ],
);

/** One row per store. */
export const catalogSyncState = pgTable("catalog_sync_state", {
  id: id(),
  tenantId: tenantId(),
  storeId: storeId().unique(),
  /** 'never' | 'syncing' | 'ready' | 'error' */
  status: text("status").notNull().default("never"),
  lastFullSyncAt: timestamp("last_full_sync_at", { withTimezone: true }),
  lastIncrementalSyncAt: timestamp("last_incremental_sync_at", { withTimezone: true }),
  /** Max sourceUpdatedAt seen; the next incremental sync starts 5 minutes before it. */
  watermark: timestamp("watermark", { withTimezone: true }),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
});

export const knowledgeDocuments = pgTable("knowledge_documents", {
  id: id(),
  tenantId: tenantId(),
  storeId: storeId(),
  title: text("title").notNull(),
  /** 'markdown' | 'pdf' | 'url' */
  sourceType: text("source_type").notNull(),
  sourceUrl: text("source_url"),
  /** Extracted plain text or markdown, kept so chunks can be rebuilt and re-embedded. */
  content: text("content").notNull(),
  contentHash: text("content_hash").notNull(),
  /** 'pending' | 'ready' | 'error' */
  status: text("status").notNull().default("pending"),
  error: text("error"),
  version: integer("version").notNull().default(1),
  chunkCount: integer("chunk_count").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: createdAt(),
});

export const knowledgeChunks = pgTable(
  "knowledge_chunks",
  {
    id: id(),
    tenantId: tenantId(),
    storeId: storeId(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    heading: text("heading"),
    text: text("text").notNull(),
    tokenEstimate: integer("token_estimate").notNull(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
    embeddingModel: text("embedding_model"),
    searchTsv: tsvector("search_tsv").generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(heading,'') || ' ' || text)`,
    ),
    createdAt: createdAt(),
  },
  (t) => [
    unique("knowledge_chunks_seq").on(t.documentId, t.seq),
    index("knowledge_chunks_scope").on(t.tenantId, t.storeId),
    index("knowledge_chunks_tsv").using("gin", t.searchTsv),
  ],
);

/** Inbound store webhooks: verified, deduped by (store, eventId) and enqueued; processed by jobs. */
export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: id(),
    tenantId: tenantId(),
    storeId: storeId(),
    eventId: text("event_id").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    enqueuedAt: timestamp("enqueued_at", { withTimezone: true }),
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [unique("webhook_events_scope").on(t.tenantId, t.storeId, t.eventId)],
);

/** Orders attributed to a conversation. Billing-like: order id/number, total and conversation only. */
export const attributedOrders = pgTable(
  "attributed_orders",
  {
    id: id(),
    tenantId: tenantId(),
    storeId: storeId(),
    orderId: text("order_id").notNull(),
    orderNumber: text("order_number").notNull(),
    conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
    /** Fixed when the order is attributed, so the metric survives the conversation's retention purge. */
    chatAssisted: boolean("chat_assisted").notNull().default(false),
    totalAmount: integer("total_amount").notNull(),
    currency: text("currency").notNull(),
    placedAt: timestamp("placed_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [unique("attributed_orders_scope").on(t.tenantId, t.storeId, t.orderId)],
);

/** One row per tenant (tenant_id is the key). Absent row = defaults; see repos/tenant-settings.ts. */
export const tenantSettings = pgTable("tenant_settings", {
  tenantId: uuid("tenant_id")
    .primaryKey()
    .references(() => tenants.id),
  /** Partial { messagesDays, tracesDays, handoffDays, otpHours }; read through getRetention(), which clamps. */
  retention: jsonb("retention").notNull().default({}),
  /** Where handoff alerts go. Merchant staff addresses, not shopper data. */
  handoffEmails: text("handoff_emails").array().notNull().default(sql`'{}'::text[]`),
  /** { allowedCountryCodes, channels }: can only tighten the platform's send limits. */
  otp: jsonb("otp").notNull().default({}),
  requireConsent: boolean("require_consent").notNull().default(true),
  privacyNoticeUrl: text("privacy_notice_url"),
  /** sealSecret() output: the HMAC secret that signs the host page's session tokens. Never part of getTenantSettings(). */
  hostSessionSecretSealed: bytea("host_session_secret_sealed"),
  /** Shown to shoppers when the assistant is not sure and no person is reachable. */
  contactInfo: text("contact_info"),
  createdAt: createdAt(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One-time codes. Hashes only: `code_hash` is HMAC(code ‖ salt) and `destination_hash` an HMAC of the
 * normalised contact, both produced by the engine; this package stores text.
 */
export const verifications = pgTable(
  "verifications",
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /** 'sms' | 'email' */
    channel: text("channel").notNull(),
    destinationHash: text("destination_hash").notNull(),
    codeHash: text("code_hash").notNull(),
    salt: text("salt").notNull(),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Set when the code is used or replaced by a newer one; a consumed code never verifies again. */
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    // At most one live code per conversation, enforced by the database as well as by createVerification.
    uniqueIndex("verifications_one_pending").on(t.conversationId).where(sql`consumed_at is null`),
    index("verifications_destination").on(t.tenantId, t.destinationHash, t.createdAt),
    index("verifications_conversation").on(t.tenantId, t.conversationId, t.createdAt),
  ],
);

/** The shopper agreed to a privacy-notice version for this conversation. */
export const consents = pgTable(
  "consents",
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    noticeVersion: text("notice_version").notNull(),
    noticeUrl: text("notice_url"),
    createdAt: createdAt(),
  },
  (t) => [unique("consents_conversation_notice").on(t.conversationId, t.noticeVersion)],
);

/** A request for a human. `summary` is written for staff and already redacted (redactPii) by the engine. */
export const handoffs = pgTable(
  "handoffs",
  {
    id: id(),
    tenantId: tenantId(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    reason: text("reason").notNull(),
    summary: text("summary").notNull(),
    /** 'open' → 'claimed' → 'resolved' (or 'open' → 'resolved'); never backwards (see transitionHandoff). */
    status: text("status").notNull().default("open"),
    claimedBy: text("claimed_by"),
    /**
     * sealSecret() output: a contact the shopper left for staff, encrypted. Read only through
     * getHandoffContactSealed(); no other handoff read returns it.
     */
    contactSealed: bytea("contact_sealed"),
    notifiedAt: timestamp("notified_at", { withTimezone: true }),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    // One unresolved handoff per conversation; a resolved one does not block the next.
    uniqueIndex("handoffs_one_active").on(t.conversationId).where(sql`status <> 'resolved'`),
    index("handoffs_inbox").on(t.tenantId, t.status, t.createdAt),
  ],
);

/** Per-tenant staff API tokens (`st_<tenantId>.<secret>`). Only the hash is stored; the token is shown once. */
export const staffTokens = pgTable("staff_tokens", {
  id: id(),
  tenantId: tenantId(),
  name: text("name").notNull(),
  /** sha256 hex of the whole token; unique across tenants, looked up inside withTenant. */
  tokenHash: text("token_hash").notNull().unique(),
  tokenPrefix: text("token_prefix").notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
});

/** Export, deletion and offboarding receipts: counts and an HMAC subject, never shopper content. */
export const privacyRequests = pgTable("privacy_requests", {
  id: id(),
  tenantId: tenantId(),
  /** 'export' | 'delete' | 'offboard' */
  type: text("type").notNull(),
  /** identity_hash of the data subject; null for a conversation-id request or offboarding. */
  subjectHash: text("subject_hash"),
  /** 'pending' | 'running' | 'completed' | 'failed' */
  status: text("status").notNull().default("pending"),
  /** Rows touched per table. */
  counts: jsonb("counts").notNull().default({}),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: createdAt(),
});

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
  "catalog_products",
  "catalog_variants",
  "catalog_sync_state",
  "knowledge_documents",
  "knowledge_chunks",
  "webhook_events",
  "attributed_orders",
  "tenant_settings",
  "verifications",
  "consents",
  "handoffs",
  "staff_tokens",
  "privacy_requests",
] as const;
