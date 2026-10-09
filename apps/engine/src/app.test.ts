import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { clientIp } from "./client-ip";
import { createLogger } from "./log";

const logger = createLogger({ level: "silent" });

describe("createApp", () => {
  it("reports health from the database ping", async () => {
    const up = createApp({ logger, ping: async () => true, resolveWidgetKey: async () => null });
    expect(await (await up.request("/healthz")).json()).toEqual({ ok: true });
    const down = createApp({ logger, ping: async () => false, resolveWidgetKey: async () => null });
    expect((await down.request("/healthz")).status).toBe(503);
  });

  it("turns unexpected errors into the standard error shape without leaking details", async () => {
    const app = createApp({
      logger,
      ping: async () => {
        throw new Error("password=hunter2");
      },
      resolveWidgetKey: async () => null,
    });
    const res = await app.request("/healthz");
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(JSON.parse(body)).toEqual({ error: { code: "internal", message: expect.any(String) } });
    expect(body).not.toContain("hunter2");
  });

  it("guards /v1 routes with the widget key", async () => {
    const app = createApp({ logger, ping: async () => true, resolveWidgetKey: async () => null });
    expect(
      (await app.request("/v1/chat", { method: "POST", headers: { origin: "https://x.test" } })).status,
    ).toBe(401);
  });
});

describe("clientIp", () => {
  it("takes the address the trusted proxy saw", () => {
    expect(clientIp("203.0.113.9, 10.0.0.2", "10.0.0.3", 1)).toBe("10.0.0.2");
    expect(clientIp("203.0.113.9, 10.0.0.2", "10.0.0.3", 2)).toBe("203.0.113.9");
    expect(clientIp(undefined, "10.0.0.3", 1)).toBe("10.0.0.3");
    expect(clientIp("1.1.1.1", "10.0.0.3", 0)).toBe("10.0.0.3");
  });
});
