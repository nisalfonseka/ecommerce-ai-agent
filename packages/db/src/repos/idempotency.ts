import { and, eq, sql } from "drizzle-orm";
import { type Db, withTenant } from "../client";
import { idempotencyRecords } from "../schema";

export interface IdempotencyScope {
  storeId: string;
  operation: string;
  target: string;
  key: string;
}

export type IdempotencyStatus = "in_progress" | "completed" | "ambiguous";

export interface IdempotencyRecord {
  status: IdempotencyStatus;
  fingerprint: string;
  result: unknown;
  reconcile: unknown;
  updatedAt: Date;
}

/** Storage for ADR-002 idempotency. `begin` claims the scope atomically or returns the existing record. */
export interface IdempotencyStore {
  begin(scope: IdempotencyScope, fingerprint: string): Promise<"new" | IdempotencyRecord>;
  complete(scope: IdempotencyScope, result: unknown): Promise<void>;
  markAmbiguous(scope: IdempotencyScope, reconcile: unknown): Promise<void>;
  remove(scope: IdempotencyScope): Promise<void>;
}

/** Postgres-backed store for one tenant; each call is its own short transaction. */
export function createPgIdempotencyStore(db: Db, tenantId: string): IdempotencyStore {
  const where = (scope: IdempotencyScope) =>
    and(
      eq(idempotencyRecords.tenantId, tenantId),
      eq(idempotencyRecords.storeId, scope.storeId),
      eq(idempotencyRecords.operation, scope.operation),
      eq(idempotencyRecords.target, scope.target),
      eq(idempotencyRecords.key, scope.key),
    );
  return {
    begin: (scope, fingerprint) =>
      withTenant(db, tenantId, async (tx) => {
        const inserted = await tx
          .insert(idempotencyRecords)
          .values({ tenantId, ...scope, fingerprint, status: "in_progress" })
          .onConflictDoNothing()
          .returning({ id: idempotencyRecords.id });
        if (inserted.length > 0) return "new";
        const [row] = await tx.select().from(idempotencyRecords).where(where(scope));
        if (!row) throw new Error("idempotency record vanished");
        return {
          status: row.status as IdempotencyStatus,
          fingerprint: row.fingerprint,
          result: row.result,
          reconcile: row.reconcile,
          updatedAt: row.updatedAt,
        };
      }),
    complete: (scope, result) =>
      withTenant(db, tenantId, async (tx) => {
        await tx
          .update(idempotencyRecords)
          .set({ status: "completed", result, updatedAt: sql`now()` })
          .where(where(scope));
      }),
    markAmbiguous: (scope, reconcile) =>
      withTenant(db, tenantId, async (tx) => {
        await tx
          .update(idempotencyRecords)
          .set({ status: "ambiguous", reconcile, updatedAt: sql`now()` })
          .where(where(scope));
      }),
    remove: (scope) =>
      withTenant(db, tenantId, async (tx) => {
        await tx.delete(idempotencyRecords).where(where(scope));
      }),
  };
}
