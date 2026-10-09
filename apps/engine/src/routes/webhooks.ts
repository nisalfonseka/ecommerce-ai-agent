import {
  type Db,
  markWebhookEnqueued,
  openSecret,
  recordWebhookEvent,
  resolveWebhookStore,
  withTenant,
} from "@ace/db";
import { JOBS, type JobQueue } from "@ace/db/jobs";
import type { Hono } from "hono";
import type { Logger } from "pino";
import { z } from "zod";
import type { WidgetEnv } from "../auth/widget";
import { errorResponse } from "../http-errors";
import { AceWebhookSchema } from "../webhooks/payload";
import { verifyAceWebhook } from "../webhooks/signature";

export interface WebhookDeps {
  db: Db;
  jobs: JobQueue;
  masterKey: Buffer;
  logger: Logger;
  /** Unix seconds; injectable for tests. */
  now?: () => number;
}

export const MAX_WEBHOOK_BYTES = 65_536;
/** Product events for one product within this window collapse into one sync job (leading + one trailing). */
const PRODUCT_DEBOUNCE_SECONDS = 5;

/** Reads at most `limit` bytes, whatever Content-Length claims. Null when the body is larger. */
async function readCapped(request: Request, limit: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Signed ingress for ACE webhook v1. It only verifies, dedupes and enqueues; the jobs do the work. Mounted
 * outside /v1: callers are stores, not widgets, so there is no widget key and no CORS.
 */
export function registerWebhookRoutes(app: Hono<WidgetEnv>, deps: WebhookDeps): void {
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  app.post("/webhooks/:storeId", async (c) => {
    const storeId = c.req.param("storeId");
    // resolveWebhookStore casts to uuid and would throw on anything else.
    if (!z.uuid().safeParse(storeId).success) return errorResponse(c, 404, "not_found", "Not found.");

    const rawBody = await readCapped(c.req.raw, MAX_WEBHOOK_BYTES);
    if (rawBody === null) return errorResponse(c, 413, "invalid_input", "Payload too large.");

    // Same answer for "no such store" and "no secret yet", so callers learn nothing about which stores exist.
    const store = await resolveWebhookStore(deps.db, storeId);
    if (!store?.webhookSecretSealed) return errorResponse(c, 404, "not_found", "Not found.");

    const secret = openSecret(store.webhookSecretSealed, deps.masterKey);
    const verified = verifyAceWebhook({
      secret,
      timestampHeader: c.req.header("x-ace-timestamp"),
      signatureHeader: c.req.header("x-ace-signature"),
      rawBody,
      nowSeconds: now(),
    });
    if (!verified) {
      deps.logger.warn({ storeId }, "webhook signature rejected");
      return errorResponse(c, 401, "invalid_signature", "Invalid signature.");
    }

    let json: unknown;
    try {
      json = JSON.parse(rawBody);
    } catch {
      return errorResponse(c, 400, "invalid_input", "Body must be JSON.");
    }
    const parsed = AceWebhookSchema.safeParse(json);
    if (!parsed.success) return errorResponse(c, 400, "invalid_input", "Unrecognised webhook payload.");
    const event = parsed.data;
    const { tenantId } = store;

    const recorded = await withTenant(deps.db, tenantId, (tx) =>
      recordWebhookEvent(tx, tenantId, { storeId, eventId: event.eventId, type: event.type, payload: event }),
    );
    if (!recorded.isNew && recorded.enqueuedAt) return c.json({ ok: true, duplicate: true });

    // A failed enqueue leaves enqueuedAt null, so the store's retry takes this path again.
    try {
      if (event.type === "order.placed") {
        await deps.jobs.send(JOBS.orderPlaced, { tenantId, storeId, eventId: event.eventId });
      } else {
        await deps.jobs.send(
          JOBS.syncProduct,
          { tenantId, storeId, productId: event.productId },
          { debounceKey: `${storeId}:${event.productId}`, debounceSeconds: PRODUCT_DEBOUNCE_SECONDS },
        );
      }
      await withTenant(deps.db, tenantId, (tx) => markWebhookEnqueued(tx, recorded.id));
    } catch (error) {
      deps.logger.error({ storeId, err: error }, "webhook enqueue failed");
      return errorResponse(c, 503, "unavailable", "Temporarily unavailable. Retry.");
    }
    return c.json({ ok: true });
  });
}
