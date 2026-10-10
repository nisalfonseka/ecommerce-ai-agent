import { and, asc, count, gte, isNotNull, lt, sql, sum } from "drizzle-orm";
import type { Tx } from "../client";
import { attributedOrders } from "../schema";

export interface AttributedOrderInput {
  tenantId: string;
  storeId: string;
  orderId: string;
  orderNumber: string;
  /** Null when the order is not chat-assisted (no, malformed or foreign conversation id). */
  conversationId: string | null;
  /** Integer minor units. */
  totalAmount: number;
  currency: string;
  placedAt: Date;
}

export interface AttributionReport {
  orders: number;
  chatAssisted: number;
  /** One entry per currency, sorted by currency code; amounts in minor units. */
  revenue: { currency: string; total: number; chatAssisted: number }[];
}

/** One row per (tenant, store, order): a redelivered or retried event overwrites, never duplicates. */
export async function upsertAttributedOrder(tx: Tx, row: AttributedOrderInput): Promise<void> {
  const { tenantId: _tenantId, storeId: _storeId, orderId: _orderId, ...update } = row;
  await tx
    .insert(attributedOrders)
    .values(row)
    .onConflictDoUpdate({
      target: [attributedOrders.tenantId, attributedOrders.storeId, attributedOrders.orderId],
      set: update,
    });
}

/** Orders placed in [from, to). Revenue is grouped by currency: amounts in different currencies never add. */
export async function attributionReport(tx: Tx, range: { from: Date; to: Date }): Promise<AttributionReport> {
  const inRange = and(gte(attributedOrders.placedAt, range.from), lt(attributedOrders.placedAt, range.to));
  const assisted = isNotNull(attributedOrders.conversationId);
  const rows = await tx
    .select({
      currency: attributedOrders.currency,
      orders: count(),
      chatAssisted: count(attributedOrders.conversationId),
      total: sum(attributedOrders.totalAmount),
      chatAssistedTotal: sql<string | null>`sum(${attributedOrders.totalAmount}) filter (where ${assisted})`,
    })
    .from(attributedOrders)
    .where(inRange)
    .groupBy(attributedOrders.currency)
    .orderBy(asc(attributedOrders.currency));
  // sum() of integers is numeric in Postgres (a string here); minor-unit totals stay far below 2^53.
  return {
    orders: rows.reduce((n, r) => n + r.orders, 0),
    chatAssisted: rows.reduce((n, r) => n + r.chatAssisted, 0),
    revenue: rows.map((r) => ({
      currency: r.currency,
      total: Number(r.total ?? 0),
      chatAssisted: Number(r.chatAssistedTotal ?? 0),
    })),
  };
}
