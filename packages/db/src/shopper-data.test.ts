import { getTableColumns, getTableName } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "./schema";
import { SHOPPER_DATA_TABLES } from "./shopper-data";

const tables = Object.values(schema as Record<string, unknown>).filter(
  (value): value is PgTable => value instanceof PgTable,
);

describe("SHOPPER_DATA_TABLES", () => {
  it("lists every table that holds conversation data, for the purge and export jobs", () => {
    const withConversation = tables
      .filter((table) => "conversationId" in getTableColumns(table))
      .map((table) => getTableName(table));
    const registered = SHOPPER_DATA_TABLES.map((entry) => entry.table);
    for (const name of [...withConversation, "conversations"]) expect(registered, name).toContain(name);
  });

  it("gives every entry a positive retention", () => {
    for (const entry of SHOPPER_DATA_TABLES) expect(entry.retentionDays, entry.table).toBeGreaterThan(0);
  });
});
