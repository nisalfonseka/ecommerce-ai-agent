import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { type WidgetEnv, widgetAuth } from "./widget";

const keys: Record<string, { tenantId: string; botId: string; allowedOrigins: string[] }> = {
  pk_live_good: { tenantId: "t1", botId: "b1", allowedOrigins: ["https://shop.test"] },
};

function app() {
  const hono = new Hono<WidgetEnv>();
  hono.use("/v1/*", widgetAuth({ resolveWidgetKey: async (key) => keys[key] ?? null }));
  hono.post("/v1/ping", (c) => c.json({ tenantId: c.var.widget.tenantId }));
  return hono;
}

const call = (headers: Record<string, string>) => app().request("/v1/ping", { method: "POST", headers });

describe("widgetAuth", () => {
  it("accepts a known key from an allowed origin and sets CORS for it", async () => {
    const res = await call({ authorization: "Bearer pk_live_good", origin: "https://shop.test" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ tenantId: "t1" });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://shop.test");
    expect(res.headers.get("vary")).toContain("Origin");
  });

  it("rejects a missing or unknown key with 401", async () => {
    expect((await call({ origin: "https://shop.test" })).status).toBe(401);
    expect((await call({ authorization: "Bearer pk_live_nope", origin: "https://shop.test" })).status).toBe(
      401,
    );
  });

  it("rejects other origins with 403 and no CORS grant", async () => {
    const res = await call({ authorization: "Bearer pk_live_good", origin: "https://evil.test" });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "forbidden_origin", message: expect.any(String) } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect((await call({ authorization: "Bearer pk_live_good" })).status).toBe(403);
  });

  it("answers preflight without a key, granting nothing beyond the request's own origin", async () => {
    const res = await app().request("/v1/ping", {
      method: "OPTIONS",
      headers: { origin: "https://shop.test", "access-control-request-method": "POST" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://shop.test");
    // Every header the widget sends must be allowed, or the browser blocks the request.
    for (const header of ["authorization", "content-type", "x-visitor-id", "x-conversation-token"]) {
      expect(res.headers.get("access-control-allow-headers"), header).toContain(header);
    }
  });
});
