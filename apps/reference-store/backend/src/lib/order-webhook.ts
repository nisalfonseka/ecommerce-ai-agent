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

export function signWebhook(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

const BACKOFF_MS = [1000, 4000];

export async function sendOrderWebhook(
  payload: OrderWebhookPayload,
  options: {
    url: string;
    secret: string;
    fetch?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<void> {
  const doFetch = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const body = JSON.stringify(payload);
  let lastError: unknown;
  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt += 1) {
    if (attempt > 0) await sleep(BACKOFF_MS[attempt - 1] ?? 0);
    try {
      const response = await doFetch(options.url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ace-signature": signWebhook(body, options.secret) },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (response.ok) return;
      lastError = new Error(`order webhook answered ${response.status}`);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
