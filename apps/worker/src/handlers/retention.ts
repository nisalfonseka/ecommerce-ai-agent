import { type Db, listTenantIds, SHOPPER_DATA_TABLES, withTenant } from "@ace/db";
import { JOBS } from "@ace/db/jobs";
import { sql } from "drizzle-orm";
import type { WorkerDeps, WorkerJob } from "../deps";
import { parsePayload } from "../job";

const DAY_MS = 24 * 60 * 60 * 1000;
const BATCH_SIZE = 1_000;

/** What "age" means per table; created_at unless listed. A conversation ages from its last message. */
const AGE_COLUMN: Readonly<Record<string, string>> = {
  conversations: "last_message_at",
  webhook_events: "received_at",
};

/**
 * Deletes one tenant's expired rows, table by table, in short transactions of at most `batchSize` rows so a
 * large purge never holds long locks. Returns rows deleted per table (deleting a conversation also cascades
 * its messages, tool calls and traces; those are not counted again).
 */
export async function purgeTenant(
  db: Db,
  tenantId: string,
  now: Date,
  batchSize = BATCH_SIZE,
): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const { table, retentionDays } of SHOPPER_DATA_TABLES) {
    const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
    const name = sql.identifier(table);
    const age = sql.identifier(AGE_COLUMN[table] ?? "created_at");
    let deleted = 0;
    for (;;) {
      const result = await withTenant(db, tenantId, (tx) =>
        tx.execute(
          sql`delete from ${name} where id in (select id from ${name} where ${age} < ${cutoff} limit ${batchSize})`,
        ),
      );
      const batch = result.rowCount ?? 0;
      deleted += batch;
      if (batch < batchSize) break;
    }
    counts[table] = deleted;
  }
  return counts;
}

/** Each tenant is purged inside its own RLS context; a tenant's rows are never visible to another's pass. */
export async function handleRetentionPurge(
  deps: WorkerDeps,
  job: WorkerJob,
): Promise<Record<string, Record<string, number>> | undefined> {
  if (!parsePayload(JOBS.retentionPurge, job, deps.logger)) return undefined;
  const now = deps.now();
  const result: Record<string, Record<string, number>> = {};
  for (const tenantId of await listTenantIds(deps.db)) {
    const counts = await purgeTenant(deps.db, tenantId, now);
    result[tenantId] = counts;
    for (const [table, deleted] of Object.entries(counts)) {
      // Counts only, never content.
      if (deleted > 0)
        deps.logger.info({ job: JOBS.retentionPurge, tenantId, table, deleted }, "retention purged");
    }
  }
  return result;
}
