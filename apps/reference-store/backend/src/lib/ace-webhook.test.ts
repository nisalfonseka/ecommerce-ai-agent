import { describe, expect, it, vi } from "vitest";
import { orderWebhookPayload, productWebhookPayload, sendAceWebhook, signWebhook } from "./ace-webhook";

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

describe("productWebhookPayload", () => {
  it("carries ids and times only", () => {
    const payload = productWebhookPayload("inventory.updated", "prod_1", Date.UTC(2026, 9, 9));
    expect(payload).toEqual({
      eventId: `inventory.updated:prod_1:${Date.UTC(2026, 9, 9)}`,
      type: "inventory.updated",
      productId: "prod_1",
      occurredAt: "2026-10-09T00:00:00.000Z",
    });
    expect(Object.keys(payload).sort()).toEqual(["eventId", "occurredAt", "productId", "type"]);
  });
});

describe("order payload privacy", () => {
  it("has no shopper fields", () => {
    const payload = orderWebhookPayload({
      ...order,
      metadata: { ...order.metadata, email: "a@b.lk" },
      ...{ email: "a@b.lk", shipping_address: { phone: "077" } },
    } as typeof order);
    expect(JSON.stringify(payload)).not.toMatch(/a@b\.lk|077|email|address|phone/);
  });
});

describe("signWebhook", () => {
  it("matches the fixed vector shared with the engine", () => {
    expect(
      signWebhook(
        '{"eventId":"product.updated:p_1:1","type":"product.updated","productId":"p_1","occurredAt":"2026-10-09T00:00:00.000Z"}',
        "test-webhook-secret-0123456789",
        1791500000,
      ),
    ).toBe("sha256=3d49e872361e43452cedb4c12201824c654d50f335e96d4a4f37a92643e2dbb5");
  });
});

describe("sendAceWebhook", () => {
  it("signs the timestamp and exact body", async () => {
    const fetch = vi.fn(async () => new Response("ok", { status: 200 }));
    await sendAceWebhook(orderWebhookPayload(order), {
      url: "https://engine.test/hook",
      secret: "s3cret",
      fetch,
      now: () => 1791500000_900,
    });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://engine.test/hook");
    const body = String(init.body);
    const headers = init.headers as Record<string, string>;
    expect(headers["x-ace-timestamp"]).toBe("1791500000");
    expect(headers["x-ace-signature"]).toBe(signWebhook(body, "s3cret", 1791500000));
    expect(headers["content-type"]).toBe("application/json");
  });

  it("signs each retry with a fresh timestamp", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("down", { status: 503 }))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    const times = [1791500000_000, 1791500400_000];
    await sendAceWebhook(orderWebhookPayload(order), {
      url: "https://e.test",
      secret: "s",
      fetch,
      sleep: async () => {},
      now: () => times.shift() ?? 0,
    });
    const stamps = fetch.mock.calls.map(
      (call) =>
        ((call as unknown as [string, RequestInit])[1].headers as Record<string, string>)["x-ace-timestamp"],
    );
    expect(stamps).toEqual(["1791500000", "1791500400"]);
  });

  it("retries failures with backoff, then gives up with an error", async () => {
    const fetch = vi.fn(async () => new Response("down", { status: 503 }));
    const sleep = vi.fn(async () => {});
    await expect(
      sendAceWebhook(orderWebhookPayload(order), { url: "https://e.test", secret: "s", fetch, sleep }),
    ).rejects.toThrow(/503/);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((call) => (call as unknown as [number])[0])).toEqual([1000, 4000]);
  });

  it("stops retrying after a success", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("ECONNRESET"))
      .mockResolvedValueOnce(new Response("ok", { status: 200 }));
    await sendAceWebhook(orderWebhookPayload(order), {
      url: "https://e.test",
      secret: "s",
      fetch,
      sleep: async () => {},
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
