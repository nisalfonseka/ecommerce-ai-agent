// @vitest-environment node

import { beforeEach, describe, expect, it, vi } from "vitest";
import { listHandoffs } from "./staff-api";

const goToLogin = vi.fn((): never => {
  throw new Error("redirect:/login");
});

describe("staff API client", () => {
  beforeEach(() => {
    goToLogin.mockClear();
  });

  it("sends the staff token and returns newest-first handoffs", async () => {
    const fetch = vi.fn(async () =>
      Response.json([
        {
          id: "old",
          conversationId: "c1",
          reason: "complaint",
          summary: "Old",
          status: "open",
          claimedBy: null,
          createdAt: "2026-10-13T10:00:00.000Z",
        },
        {
          id: "new",
          conversationId: "c2",
          reason: "refund",
          summary: "New",
          status: "open",
          claimedBy: null,
          createdAt: "2026-10-14T10:00:00.000Z",
        },
      ]),
    );
    const result = await listHandoffs("st_token", fetch, goToLogin);
    expect(result.map((item) => item.id)).toEqual(["new", "old"]);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/staff/v1/handoffs?status=open"),
      expect.objectContaining({ headers: { authorization: "Bearer st_token" }, cache: "no-store" }),
    );
  });

  it("maps an unauthorized engine response to the login page", async () => {
    const fetch = vi.fn(async () => Response.json({ error: {} }, { status: 401 }));
    await expect(listHandoffs("bad", fetch, goToLogin)).rejects.toThrow("redirect:/login");
    expect(goToLogin).toHaveBeenCalledOnce();
  });
});
