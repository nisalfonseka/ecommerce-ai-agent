import { getTableColumns, getTableName } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "./schema";
import { TENANT_TABLES } from "./schema";
import { MERCHANT_CONTENT_TABLES, SHOPPER_DATA_TABLES } from "./shopper-data";

/** Billing-like facts (ids, totals); the conversation link is ON DELETE SET NULL, so a purge needs no entry. */
const BILLING_ONLY = new Set(["attributed_orders"]);

/**
 * Phase 7 tables that hold configuration, staff-token hashes or deletion receipts, never shopper content
 * (privacy_requests keeps an HMAC subject and counts). They are outside the shopper purge and export on purpose:
 * a receipt must outlive the data it proves was deleted.
 */
const NO_SHOPPER_CONTENT = new Set(["tenant_settings", "staff_tokens", "privacy_requests"]);

const tables = Object.values(schema as Record<string, unknown>).filter(
  (value): value is PgTable => value instanceof PgTable,
);

describe("SHOPPER_DATA_TABLES", () => {
  it("lists every table that holds conversation data, for the purge and export jobs", () => {
    const withConversation = tables
      .filter((table) => "conversationId" in getTableColumns(table))
      .map((table) => getTableName(table))
      .filter((name) => !BILLING_ONLY.has(name));
    const registered = SHOPPER_DATA_TABLES.map((entry) => entry.table);
    for (const name of [...withConversation, "conversations"]) expect(registered, name).toContain(name);
  });

  it("gives every entry a positive retention", () => {
    for (const entry of SHOPPER_DATA_TABLES) expect(entry.retentionDays, entry.table).toBeGreaterThan(0);
  });

  it("registers the Phase 7 shopper tables with their default retention", () => {
    const days = Object.fromEntries(SHOPPER_DATA_TABLES.map((entry) => [entry.table, entry.retentionDays]));
    // verifications are purged by tenant_settings.retention.otpHours (default 24 h), so one day here.
    expect(days).toMatchObject({ handoffs: 180, verifications: 1, consents: 180 });
  });
});

describe("tables without shopper content", () => {
  it("are tenant tables that stay outside the shopper purge and export", () => {
    const shopper = SHOPPER_DATA_TABLES.map((entry) => entry.table);
    for (const name of NO_SHOPPER_CONTENT) {
      expect(TENANT_TABLES, name).toContain(name);
      expect(shopper, name).not.toContain(name);
      expect(MERCHANT_CONTENT_TABLES, name).not.toContain(name);
    }
  });

  it("really have no conversation link, which is what would make them shopper data", () => {
    const byName = new Map(tables.map((table) => [getTableName(table), table]));
    for (const name of NO_SHOPPER_CONTENT) {
      const table = byName.get(name);
      expect(table, name).toBeDefined();
      if (table) expect("conversationId" in getTableColumns(table), name).toBe(false);
    }
  });
});

describe("MERCHANT_CONTENT_TABLES", () => {
  it("registers the knowledge tables as merchant content, outside the shopper purge", () => {
    const shopper = SHOPPER_DATA_TABLES.map((entry) => entry.table);
    for (const table of ["knowledge_documents", "knowledge_chunks"]) {
      expect(MERCHANT_CONTENT_TABLES).toContain(table);
      expect(shopper).not.toContain(table);
    }
  });
});
