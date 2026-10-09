import { CommerceError } from "@ace/contracts";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MedusaHttp } from "./http";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function client(response: Response | Error) {
  const fetch = vi.fn(async () => {
    if (response instanceof Error) throw response;
    return response;
  });
  const http = new MedusaHttp({
    baseUrl: "https://store.example.lk/",
    publishableKey: "pk_test",
    secretKey: "sk_test",
    timeoutMs: 1000,
    fetch,
  });
  return { http, fetch };
}

async function errorOf(promise: Promise<unknown>): Promise<CommerceError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CommerceError) return error;
    throw error;
  }
  throw new Error("expected a CommerceError");
}

const Ok = z.object({ ok: z.boolean() });

describe("MedusaHttp", () => {
  it("sends the publishable key to the Store API and builds array queries", async () => {
    const { http, fetch } = client(json(200, { ok: true }));
    await http.store(Ok, "GET", "/store/product-variants", { query: { id: ["a", "b"], limit: 2 } });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://store.example.lk/store/product-variants?id%5B%5D=a&id%5B%5D=b&limit=2");
    expect((init.headers as Record<string, string>)["x-publishable-api-key"]).toBe("pk_test");
  });

  it("sends the secret key as Basic auth to the Admin API, and never to the Store API", async () => {
    const { http, fetch } = client(json(200, { ok: true }));
    await http.admin(Ok, "GET", "/admin/orders");
    const headers = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(headers.authorization).toBe(`Basic ${Buffer.from("sk_test:").toString("base64")}`);
    expect(headers["x-publishable-api-key"]).toBeUndefined();
  });

  it.each([
    [404, { type: "not_found", message: "Cart id not found: x" }, "NOT_FOUND"],
    [400, { code: "insufficient_inventory", type: "not_allowed", message: "…" }, "OUT_OF_STOCK"],
    [
      400,
      {
        type: "invalid_data",
        message: "Variants v1 do not exist or belong to a product that is not published",
      },
      "NOT_FOUND",
    ],
    [400, { type: "invalid_data", message: "Invalid request: Expected type: 'number'" }, "INVALID_INPUT"],
    [400, { type: "not_allowed", message: "Cart is completed" }, "CONFLICT"],
    [401, { type: "unauthorized" }, "UNAUTHORIZED"],
    [403, {}, "UNAUTHORIZED"],
    [429, {}, "RATE_LIMITED"],
    [500, { type: "unknown_error" }, "UPSTREAM_UNAVAILABLE"],
    [502, "<html>", "UPSTREAM_UNAVAILABLE"],
  ] as const)(
    "translates HTTP %i %j into %s without leaking the platform message",
    async (status, body, code) => {
      const { http } = client(json(status, body));
      const error = await errorOf(http.store(Ok, "GET", "/store/x"));
      expect(error.code).toBe(code);
      expect(error.message).not.toMatch(/Cart id|Variants v1|Expected type/);
      expect(error.details).toMatchObject({ platformStatus: status });
      expect(error.cause).toBeDefined();
    },
  );

  it("reports network errors and timeouts as UPSTREAM_UNAVAILABLE", async () => {
    const { http } = client(new TypeError("fetch failed"));
    expect((await errorOf(http.store(Ok, "GET", "/store/x"))).code).toBe("UPSTREAM_UNAVAILABLE");
    const timeout = client(new DOMException("timed out", "TimeoutError"));
    expect((await errorOf(timeout.http.store(Ok, "GET", "/store/x"))).code).toBe("UPSTREAM_UNAVAILABLE");
  });

  it("rejects a response that does not match the expected shape", async () => {
    const { http } = client(json(200, { ok: "yes" }));
    expect((await errorOf(http.store(Ok, "GET", "/store/x"))).code).toBe("UPSTREAM_UNAVAILABLE");
  });
});
