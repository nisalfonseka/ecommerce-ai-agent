import { CommerceError } from "@ace/contracts";
import { describe, expect, it } from "vitest";
import { runTool, ToolFailure } from "./tool-result";

describe("runTool", () => {
  it("wraps successful data", async () => {
    expect(await runTool(async () => ({ x: 1 }))).toEqual({ ok: true, data: { x: 1 } });
  });

  it("maps CommerceError to a typed failure without zod issues", async () => {
    const result = await runTool(async () => {
      throw new CommerceError("OUT_OF_STOCK", "Only 1 left", { variantId: "v", available: 1, issues: [] });
    });
    expect(result).toEqual({
      ok: false,
      error: {
        code: "OUT_OF_STOCK",
        message: "Only 1 left",
        retryable: false,
        details: { variantId: "v", available: 1 },
      },
    });
  });

  it("maps ToolFailure to its code", async () => {
    const result = await runTool(async () => {
      throw new ToolFailure("UNKNOWN_REF", "Search again", { ref: "#7" });
    });
    expect(result).toEqual({
      ok: false,
      error: { code: "UNKNOWN_REF", message: "Search again", retryable: false, details: { ref: "#7" } },
    });
  });

  it("hides unexpected errors behind a retryable UPSTREAM_UNAVAILABLE", async () => {
    const result = await runTool(async () => {
      throw new Error("ECONNRESET at 10.0.0.5:5432 password=hunter2");
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("UPSTREAM_UNAVAILABLE");
      expect(result.error.retryable).toBe(true);
      expect(result.error.message).not.toContain("hunter2");
    }
  });

  it("passes unexpected errors to the hook", async () => {
    const boom = new Error("boom");
    const seen: unknown[] = [];
    const result = await runTool(
      async () => {
        throw boom;
      },
      (error) => seen.push(error),
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(boom);
    expect(result).toEqual({
      ok: false,
      error: {
        code: "UPSTREAM_UNAVAILABLE",
        message: "The store could not be reached. Apologise, and offer to try again or to connect a person.",
        retryable: true,
      },
    });
  });

  it("re-throws AbortError", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    await expect(
      runTool(async () => {
        throw abort;
      }),
    ).rejects.toBe(abort);
  });
});
