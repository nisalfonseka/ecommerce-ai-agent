import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createDb } from "@ace/db";
import type { JobName, JobPayload, JobQueue } from "@ace/db/jobs";
import { createTestDatabase } from "@ace/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { loadModelPrices } from "../budget";
import { createLogger } from "../log";
import { signAceWebhook } from "../webhooks/signature";
import { registerAdminRoutes } from "./admin";
import { MAX_WEBHOOK_BYTES, registerWebhookRoutes } from "./webhooks";

const testDb = await createTestDatabase();
const ADMIN_KEY = "admin-test-key-0123456789";
const NOW = 1_791_500_000;

interface Sent {
  name: string;
  data: unknown;
  options?: { debounceKey?: string; debounceSeconds?: number };
}

describe.skipIf(testDb === null)("webhook ingress", () => {
  let pool: ReturnType<typeof createDb>;
  let app: ReturnType<typeof createApp>;
  const sent: Sent[] = [];
  let failNextSend = false;

  const jobs: JobQueue = {
    async send<N extends JobName>(
      name: N,
      data: JobPayload<N>,
      options?: { debounceKey?: string; debounceSeconds?: number },
    ) {
      if (failNextSend) {
        failNextSend = false;
        throw new Error("queue down");
      }
      sent.push({ name, data, options });
    },
  };

  beforeAll(async () => {
    if (!testDb) return;
    pool = createDb(testDb.appUrl);
    app = createApp({
      logger: createLogger({ level: "silent" }),
      ping: async () => true,
      resolveWidgetKey: async () => null,
    });
    const masterKey = randomBytes(32);
    registerAdminRoutes(app, {
      db: pool.db,
      adminApiKeySha256: createHash("sha256").update(ADMIN_KEY).digest("hex"),
      masterKey,
      prices: loadModelPrices({ models: {} }),
      jobs,
    });
    registerWebhookRoutes(app, {
      db: pool.db,
      jobs,
      masterKey,
      logger: createLogger({ level: "silent" }),
      now: () => NOW,
    });
  });
  afterAll(async () => {
    await pool?.close();
    await testDb?.drop();
  });

  const admin = (path: string, body?: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN_KEY}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  async function newStore(withSecret = true) {
    // Tenant names are unique.
    const t = await admin("/admin/tenants", { name: `Hooks ${randomUUID()}` });
    const { tenantId } = (await t.json()) as { tenantId: string };
    const { storeId } = (await (
      await admin(`/admin/tenants/${tenantId}/stores`, { platform: "memory", currency: "LKR" })
    ).json()) as { storeId: string };
    let secret = "";
    if (withSecret) {
      const res = await admin(`/admin/tenants/${tenantId}/stores/${storeId}/webhook-secret`);
      expect(res.status).toBe(201);
      const issued = (await res.json()) as { secret: string; path: string };
      expect(issued.path).toBe(`/webhooks/${storeId}`);
      secret = issued.secret;
    }
    return { tenantId, storeId, secret };
  }

  const productEvent = (productId = "p_1", eventId = `product.updated:${productId}:1`) => ({
    eventId,
    type: "product.updated",
    productId,
    occurredAt: "2026-10-09T00:00:00.000Z",
  });

  function post(
    storeId: string,
    secret: string,
    payload: unknown,
    overrides: { headers?: Record<string, string>; raw?: string; timestamp?: number } = {},
  ) {
    const raw = overrides.raw ?? JSON.stringify(payload);
    const timestamp = overrides.timestamp ?? NOW;
    return app.request(`/webhooks/${storeId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-ace-timestamp": String(timestamp),
        "x-ace-signature": signAceWebhook(secret, timestamp, raw),
        ...overrides.headers,
      },
      body: raw,
    });
  }

  it("rejects every bad request with its status and enqueues nothing", async () => {
    const { storeId, secret } = await newStore();
    const noSecret = await newStore(false);
    const before = sent.length;
    const event = productEvent();

    expect((await post("not-a-uuid", secret, event)).status).toBe(404);
    expect((await post(randomUUID(), secret, event)).status).toBe(404);
    expect((await post(noSecret.storeId, "whatever", event)).status).toBe(404);

    expect((await post(storeId, "wrong-secret", event)).status).toBe(401);
    expect((await post(storeId, secret, event, { headers: { "x-ace-signature": "" } })).status).toBe(401);
    expect(
      (await post(storeId, secret, event, { headers: { "x-ace-timestamp": "", "x-ace-signature": "" } }))
        .status,
    ).toBe(401);
    expect((await post(storeId, secret, event, { timestamp: NOW - 301 })).status).toBe(401);
    expect((await post(storeId, secret, event, { timestamp: NOW + 301 })).status).toBe(401);
    // Signed for different bytes than sent.
    expect(
      (
        await post(storeId, secret, event, {
          headers: { "x-ace-signature": signAceWebhook(secret, NOW, JSON.stringify(productEvent("p_2"))) },
        })
      ).status,
    ).toBe(401);

    expect((await post(storeId, secret, null, { raw: "{not json" })).status).toBe(400);
    expect((await post(storeId, secret, { ...event, type: "order.refunded" })).status).toBe(400);
    expect((await post(storeId, secret, { ...event, productId: "" })).status).toBe(400);

    const big = JSON.stringify({ ...event, pad: "x".repeat(MAX_WEBHOOK_BYTES) });
    expect((await post(storeId, secret, null, { raw: big })).status).toBe(413);
    // A lying Content-Length does not get around the cap.
    expect(
      (await post(storeId, secret, null, { raw: big, headers: { "content-length": "10" } })).status,
    ).toBe(413);
    expect(sent.length).toBe(before);
  });

  it("enqueues a valid product event once, debounced per product, and answers a replay as duplicate", async () => {
    const { tenantId, storeId, secret } = await newStore();
    const event = productEvent("p_9");
    const before = sent.length;
    const first = await post(storeId, secret, event);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ ok: true });
    expect(sent.slice(before)).toEqual([
      {
        name: "sync.product",
        data: { tenantId, storeId, productId: "p_9" },
        options: { debounceKey: `${storeId}:p_9`, debounceSeconds: 5 },
      },
    ]);
    const again = await post(storeId, secret, event);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    expect(sent.length).toBe(before + 1);
  });

  it("enqueues order.placed with the event id", async () => {
    const { tenantId, storeId, secret } = await newStore();
    const before = sent.length;
    const order = {
      eventId: "order.placed:o_1",
      type: "order.placed",
      orderId: "o_1",
      orderNumber: "42",
      total: { amount: 1890000, currency: "LKR" },
      placedAt: "2026-10-09T10:00:00.000Z",
      attributes: { ace_conversation_id: "c1" },
    };
    expect((await post(storeId, secret, order)).status).toBe(200);
    expect(sent.slice(before)).toEqual([
      { name: "order.placed", data: { tenantId, storeId, eventId: "order.placed:o_1" }, options: undefined },
    ]);
  });

  it("answers 503 when the queue fails, then enqueues on the store's retry", async () => {
    const { storeId, secret } = await newStore();
    const event = productEvent("p_retry");
    const before = sent.length;
    failNextSend = true;
    expect((await post(storeId, secret, event)).status).toBe(503);
    expect(sent.length).toBe(before);
    const retry = await post(storeId, secret, event);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ok: true });
    expect(sent.length).toBe(before + 1);
    expect(await (await post(storeId, secret, event)).json()).toEqual({ ok: true, duplicate: true });
    expect(sent.length).toBe(before + 1);
  });

  it("rejects tenant A's secret on tenant B's store", async () => {
    const a = await newStore();
    const b = await newStore();
    const before = sent.length;
    expect((await post(b.storeId, a.secret, productEvent())).status).toBe(401);
    expect(sent.length).toBe(before);
  });

  it("issues a secret that verifies end to end; rotating it stops the old one", async () => {
    const { tenantId, storeId, secret: first } = await newStore();
    expect((await post(storeId, first, productEvent("p_rot", "e1"))).status).toBe(200);
    const rotated = await admin(`/admin/tenants/${tenantId}/stores/${storeId}/webhook-secret`);
    const { secret: second } = (await rotated.json()) as { secret: string };
    expect(second).not.toBe(first);
    expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await post(storeId, first, productEvent("p_rot", "e2"))).status).toBe(401);
    expect((await post(storeId, second, productEvent("p_rot", "e2"))).status).toBe(200);
  });

  it("admin: unknown or foreign stores are 404, and the key is required", async () => {
    const a = await newStore(false);
    const b = await newStore(false);
    expect((await admin(`/admin/tenants/${a.tenantId}/stores/${randomUUID()}/webhook-secret`)).status).toBe(
      404,
    );
    expect((await admin(`/admin/tenants/${b.tenantId}/stores/${a.storeId}/webhook-secret`)).status).toBe(404);
    expect(
      (
        await app.request(`/admin/tenants/${a.tenantId}/stores/${a.storeId}/webhook-secret`, {
          method: "POST",
        })
      ).status,
    ).toBe(401);
  });
});
