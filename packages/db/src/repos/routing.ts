import { sql } from "drizzle-orm";
import type { Db } from "../client";

/**
 * The only reads that happen before a tenant is known. Each wraps one SECURITY DEFINER function that
 * returns routing data only (ADR-005); the tables behind them stay invisible to ace_app without a tenant.
 */

export async function resolveWebhookStore(
  db: Db,
  storeId: string,
): Promise<{ tenantId: string; webhookSecretSealed: Buffer | null } | null> {
  const result = await db.execute<{ tenant_id: string; webhook_secret_sealed: Buffer | null }>(
    sql`select * from resolve_webhook_store(${storeId}::uuid)`,
  );
  const row = result.rows[0];
  return row ? { tenantId: row.tenant_id, webhookSecretSealed: row.webhook_secret_sealed } : null;
}

/** Stores with config.search.mode = 'index' whose tenants are active. */
export async function listSyncTargets(db: Db): Promise<{ tenantId: string; storeId: string }[]> {
  const result = await db.execute<{ tenant_id: string; store_id: string }>(
    sql`select * from list_sync_targets()`,
  );
  return result.rows.map((row) => ({ tenantId: row.tenant_id, storeId: row.store_id }));
}

export async function listTenantIds(db: Db): Promise<string[]> {
  const result = await db.execute<{ list_tenant_ids: string }>(sql`select * from list_tenant_ids()`);
  return result.rows.map((row) => row.list_tenant_ids);
}
