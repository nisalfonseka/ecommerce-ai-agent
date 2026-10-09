import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { orderWebhookPayload, sendOrderWebhook, signWebhook } from "./order-webhook";

const order = {
  id: "order_1",
  display_id: 42,
  total: 18900,
  currency_code: "lkr",
  created_at: new Date("2026-10-09T10:00:00Z"),
  metadata: { ace_conversation_id: "conv_1", other: "x" },
};

describe("orderWebhookPayload", () => {
  it("carries the order, minor-unit total and only the attribution attribute", () => {
    expect(orderWebhookPayload(order)).toEqual({
      eventId: "order.placed:order_1",
      type: "order.placed",
      orderId: "order_1",
      orderNumber: "42",
      total: { amount: 1890000, currency: "LKR" },
      placedAt: "2026-10-09T10:00:00.000Z",
      attributes: { ace_conversation_id: "conv_1" },
    });
    expect(orderWebhookPayload({ ...order, metadata: null }).attributes).toEqual({});
  });
});

describe("sendOrderWebhook", () => {
  it("signs the exact body with HMAC-SHA256", async () => {
    const fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    await sendOrderWebhook(orderWebhookPayload(order), {
      url: "https://engine.test/hook",
      secret: "s3cret",
      fetch,
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://engine.test/hook");
    const body = String(init.body);
    const headers = init.headers as Record<string, string>;
    expect(headers["x-ace-signature"]).toBe(
      `sha256=${createHmac("sha256", "s3cret").update(body).digest("hex")}`,
    );
    expect(headers["x-ace-signature"]).toBe(signWebhook(body, "s3cret"));
    expect(headers["content-type"]).toBe("application/json");
  });

  it("retries failures with backoff, then gives up with an error", async () => {
    const fetch = vi.fn(async () => new Response("down", { status: 503 }));
    const sleep = vi.fn(async () => {});
    await expect(
      sendOrderWebhook(orderWebhookPayload(order), { url: "https://e.test", secret: "s", fetch, sleep }),
    ).rejects.toThrow(/503/);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((call) => (call as unknown as [number])[0])).toEqual([1000, 4000]);
  });

  it("stops retrying after a success", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    await sendOrderWebhook(orderWebhookPayload(order), {
      url: "https://e.test",
      secret: "s",
      fetch,
      sleep: async () => {},
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
