import { describe, expect, it } from "vitest";
import { createRateLimiter } from "./rate-limit";

describe("createRateLimiter", () => {
  it("allows the limit per minute, then reports when to retry, then recovers", () => {
    let now = 0;
    const limiter = createRateLimiter({ limitPerMinute: 2, now: () => now });
    expect(limiter.check("v1")).toEqual({ ok: true });
    expect(limiter.check("v1")).toEqual({ ok: true });
    expect(limiter.check("v1")).toEqual({ ok: false, retryAfterS: 60 });
    expect(limiter.check("v2")).toEqual({ ok: true });
    now = 30_000;
    expect(limiter.check("v1")).toEqual({ ok: false, retryAfterS: 30 });
    now = 60_001;
    expect(limiter.check("v1")).toEqual({ ok: true });
  });

  it("forgets idle keys so memory stays bounded", () => {
    let now = 0;
    const limiter = createRateLimiter({ limitPerMinute: 5, now: () => now });
    for (let i = 0; i < 100; i += 1) limiter.check(`ip-${i}`);
    now = 120_000;
    limiter.check("fresh");
    expect(limiter.size()).toBe(1);
  });
});
