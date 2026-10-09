import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function createDb(url: string, options: { max?: number } = {}): { db: Db; close(): Promise<void> } {
  const pool = new pg.Pool({ connectionString: url, max: options.max ?? 10 });
  return { db: drizzle({ client: pool, schema }), close: () => pool.end() };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The only way to touch tenant data. Runs `fn` in a transaction whose app.tenant_id is `tenantId`, so
 * row-level security limits every statement to that tenant. The setting is transaction-local and cannot
 * leak to the next user of the pooled connection.
 */
export async function withTenant<T>(db: Db, tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!UUID.test(tenantId)) throw new Error("withTenant: tenantId must be a UUID");
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return fn(tx);
  });
}
