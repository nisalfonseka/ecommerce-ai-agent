// @vitest-environment node

import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("POST /api/session", () => {
  it("stores a valid token only in a secure HttpOnly strict cookie", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DASHBOARD_PUBLIC_URL", "https://dashboard.example.lk");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([])),
    );
    const response = await POST(
      new Request("https://dashboard.example.lk/api/session", {
        method: "POST",
        headers: { origin: "https://dashboard.example.lk", "content-type": "application/json" },
        body: JSON.stringify({ token: "st_616069d8-cec7-48d9-b8d0-2f3f94b80ac9.abcdefghijklmnopqrst" }),
      }),
    );
    expect(response.status).toBe(204);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("ace_staff_token=");
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=strict/i);
    expect(cookie).toMatch(/Secure/i);
    expect(await response.text()).not.toContain("abcdefghijklmnopqrst");
  });

  it("rejects a cross-origin login request", async () => {
    vi.stubEnv("DASHBOARD_PUBLIC_URL", "https://dashboard.example.lk");
    const response = await POST(
      new Request("https://dashboard.example.lk/api/session", {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ token: "st_616069d8-cec7-48d9-b8d0-2f3f94b80ac9.abcdefghijklmnopqrst" }),
      }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });
});
