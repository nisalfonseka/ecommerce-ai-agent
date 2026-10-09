import { createHmac } from "node:crypto";

/** Cart/order attribute that ties an order to the assistant conversation (same key as @ace/contracts). */
export const ATTRIBUTION_ATTRIBUTE = "ace_conversation_id";

export interface OrderWebhookPayload {
  /** Stable per order and event, so the receiver can dedupe retries. */
  eventId: string;
  type: "order.placed";
  orderId: string;
  orderNumber: string;
  /** Integer minor units (LKR has 2 decimals). */
  total: { amount: number; currency: string };
  placedAt: string;
  attributes: Record<string, string>;
}

export type ProductEventType = "product.updated" | "product.deleted" | "inventory.updated";

export interface ProductWebhookPayload {
  eventId: string;
  type: ProductEventType;
  productId: string;
  occurredAt: string;
}

export type AceWebhookPayload = OrderWebhookPayload | ProductWebhookPayload;
interface OrderLike {
  id: string;
  display_id?: number | string | null;
  total: unknown;
  currency_code: string;
  created_at: Date | string;
  metadata?: Record<string, unknown> | null;
}

/** Only the attribution attribute leaves the store: the receiver needs no shopper data. */
export function orderWebhookPayload(order: OrderLike): OrderWebhookPayload {
  const conversation = order.metadata?.[ATTRIBUTION_ATTRIBUTE];
  return {
    eventId: `order.placed:${order.id}`,
    type: "order.placed",
    orderId: order.id,
    orderNumber: String(order.display_id ?? order.id),
    total: { amount: Math.round(Number(order.total) * 100), currency: order.currency_code.toUpperCase() },
    placedAt: new Date(order.created_at).toISOString(),
    attributes: typeof conversation === "string" ? { [ATTRIBUTION_ATTRIBUTE]: conversation } : {},
  };
}

/** Ids only: the engine re-reads the product from the store API, so no catalog or shopper data is sent. */
export function productWebhookPayload(
  type: ProductEventType,
  productId: string,
  nowMs: number = Date.now(),
): ProductWebhookPayload {
  return {
    // Each change is a distinct event; the engine debounces bursts per product.
    eventId: `${type}:${productId}:${nowMs}`,
    type,
    productId,
    occurredAt: new Date(nowMs).toISOString(),
  };
}

/** ACE webhook v1: HMAC-SHA256 over "<unix seconds>.<raw body>", so a captured request cannot be replayed later. */
export function signWebhook(body: string, secret: string, timestamp: number): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

const BACKOFF_MS = [1000, 4000];

export async function sendAceWebhook(
  payload: AceWebhookPayload,
  options: {
    url: string;
    secret: string;
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
    /** Milliseconds since the epoch. */
    now?: () => number;
  },
): Promise<void> {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const body = JSON.stringify(payload);
  let lastError: unknown;
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt += 1) {
    if (attempt > 0) await sleep(BACKOFF_MS[attempt - 1] ?? 0);
    try {
      // A fresh timestamp per attempt: the engine rejects anything older than 5 minutes.
      const timestamp = Math.floor((options.now ?? Date.now)() / 1000);
      const response = await doFetch(options.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ace-timestamp": String(timestamp),
          "x-ace-signature": signWebhook(body, options.secret, timestamp),
        },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return;
      lastError = new Error(`ace webhook answered ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
