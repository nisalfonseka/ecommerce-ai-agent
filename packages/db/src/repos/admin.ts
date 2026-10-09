import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { type Db, type Tx, withTenant } from "../client";
import { bots, stores, tenants, widgetKeys } from "../schema";

export type BotRow = typeof bots.$inferSelect;
export type StoreRow = typeof stores.$inferSelect;

export interface BotInput {
  storeId: string;
  persona: unknown;
  storeFacts: unknown;
  model: string;
  cheapModel: string;
  fallbackModel?: string | null;
  budgetSoftUsdMicros: number;
  budgetHardUsdMicros: number;
  maxSteps?: number;
}

/** Creates a tenant inside its own RLS context. Pass `id` for re-runnable seeds (RLS hides lookups by name). */
export async function createTenant(
  db: Db,
  input: { name: string; id?: string },
): Promise<{ tenantId: string }> {
  const tenantId = input.id ?? randomUUID();
  await withTenant(db, tenantId, (tx) => tx.insert(tenants).values({ id: tenantId, name: input.name }));
  return { tenantId };
}

export async function createStore(
  tx: Tx,
  tenantId: string,
  input: { platform: string; currency: string; config?: unknown; credentialsSealed?: Buffer | null },
): Promise<StoreRow> {
  const [row] = await tx
    .insert(stores)
    .values({
      tenantId,
      platform: input.platform,
      currency: input.currency,
      config: input.config ?? {},
      credentialsSealed: input.credentialsSealed ?? null,
    })
    .returning();
  if (!row) throw new Error("store insert returned no row");
  return row;
}

export async function createBot(tx: Tx, tenantId: string, input: BotInput): Promise<BotRow> {
  const [row] = await tx
    .insert(bots)
    .values({ tenantId, ...input, fallbackModel: input.fallbackModel ?? null })
    .returning();
  if (!row) throw new Error("bot insert returned no row");
  return row;
}

export function hashWidgetKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** Returns the publishable key once; only its SHA-256 is stored. */
export async function issueWidgetKey(
  tx: Tx,
  tenantId: string,
  input: { botId: string; allowedOrigins: string[] },
): Promise<{ keyId: string; key: string; prefix: string }> {
  const key = `pk_live_${randomBytes(24).toString("base64url")}`;
  const prefix = key.slice(0, 12);
  const [row] = await tx
    .insert(widgetKeys)
    .values({
      tenantId,
      botId: input.botId,
      keyHash: hashWidgetKey(key),
      keyPrefix: prefix,
      allowedOrigins: input.allowedOrigins,
    })
    .returning({ id: widgetKeys.id });
  if (!row) throw new Error("widget key insert returned no row");
  return { keyId: row.id, key, prefix };
}

export async function revokeWidgetKey(tx: Tx, keyId: string): Promise<boolean> {
  const updated = await tx
    .update(widgetKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(widgetKeys.id, keyId), sql`${widgetKeys.revokedAt} is null`))
    .returning({ id: widgetKeys.id });
  return updated.length > 0;
}

/** The one pre-tenant lookup (ADR-005): key → tenant, bot and allowed origins, or null. */
export async function resolveWidgetKey(
  db: Db,
  key: string,
): Promise<{ tenantId: string; botId: string; allowedOrigins: string[] } | null> {
  const result = await db.execute<{ tenant_id: string; bot_id: string; allowed_origins: string[] }>(
    sql`select * from resolve_widget_key(${hashWidgetKey(key)})`,
  );
  const row = result.rows[0];
  return row ? { tenantId: row.tenant_id, botId: row.bot_id, allowedOrigins: row.allowed_origins } : null;
}

export async function getBotWithStore(
  tx: Tx,
  botId: string,
): Promise<{ bot: BotRow; store: StoreRow } | null> {
  const [row] = await tx
    .select()
    .from(bots)
    .innerJoin(stores, eq(bots.storeId, stores.id))
    .where(eq(bots.id, botId));
  return row ? { bot: row.bots, store: row.stores } : null;
}
