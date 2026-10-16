// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

const cookies = vi.hoisted(() => vi.fn());
const mutateHandoff = vi.hoisted(() => vi.fn());
vi.mock("next/headers", () => ({ cookies }));
vi.mock("../../../../../lib/staff-api", () => ({ mutateHandoff }));

describe("handoff mutation route", () => {
  beforeEach(() => {
    vi.stubEnv("DASHBOARD_PUBLIC_URL", "https://dashboard.example.lk");
    cookies.mockResolvedValue({ get: () => ({ value: "st_token" }) });
    mutateHandoff.mockReset();
  });

  it("requires a same-origin request before calling the engine", async () => {
    const response = await POST(
      new Request("https://dashboard.example.lk/api/handoffs/h1/claim", {
        method: "POST",
        headers: { origin: "https://evil.example" },
      }),
      { params: Promise.resolve({ id: "h1", action: "claim" }) },
    );
    expect(response.status).toBe(403);
    expect(mutateHandoff).not.toHaveBeenCalled();
  });

  it("forwards an allowed action with the server-only token", async () => {
    mutateHandoff.mockResolvedValue(undefined);
    const response = await POST(
      new Request("https://dashboard.example.lk/api/handoffs/h1/claim", {
        method: "POST",
        headers: { origin: "https://dashboard.example.lk" },
      }),
      { params: Promise.resolve({ id: "h1", action: "claim" }) },
    );
    expect(response.status).toBe(204);
    expect(mutateHandoff).toHaveBeenCalledWith("st_token", "h1", "claim", undefined);
  });
});
