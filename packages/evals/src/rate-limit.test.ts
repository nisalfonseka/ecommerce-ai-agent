import { say, scriptedModel } from "@ace/agent/testing";
import { APICallError, generateText } from "ai";
import { describe, expect, it } from "vitest";
import { createRequestPacer, retryDelayMs, withRateLimit } from "./rate-limit";

function fakeClock() {
  let now = 0;
  const waits: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      waits.push(ms);
      now += ms;
    },
    waits,
  };
}

function quotaError(body: string, headers: Record<string, string> = {}): APICallError {
  return new APICallError({
    message: "You exceeded your current quota. Please retry in 48.9s.",
    url: "https://example.test",
    requestBodyValues: {},
    statusCode: 429,
    responseHeaders: headers,
    responseBody: body,
    isRetryable: true,
  });
}

describe("createRequestPacer", () => {
  it("lets rpm requests through, then waits until the oldest leaves the 60 s window", async () => {
    const clock = fakeClock();
    const pacer = createRequestPacer({ rpm: 2, now: clock.now, sleep: clock.sleep });
    await pacer.acquire();
    await pacer.acquire();
    expect(clock.waits).toEqual([]);
    await pacer.acquire();
    expect(clock.waits).toEqual([60_000]);
  });
});

describe("retryDelayMs", () => {
  it("reads Gemini's retryDelay from the body", () => {
    expect(retryDelayMs(quotaError('{"error":{"details":[{"retryDelay":"48s"}]}}'))).toBe(48_000);
  });

  it("falls back to the message, then Retry-After, then 60 s", () => {
    expect(retryDelayMs(quotaError("{}"))).toBe(48_900);
    const noHint = new APICallError({
      message: "Too many requests",
      url: "u",
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: { "retry-after": "7" },
    });
    expect(retryDelayMs(noHint)).toBe(7_000);
    expect(
      retryDelayMs(
        new APICallError({ message: "slow down", url: "u", requestBodyValues: {}, statusCode: 429 }),
      ),
    ).toBe(60_000);
  });

  it("ignores errors that are not rate limits", () => {
    expect(retryDelayMs(new Error("boom"))).toBeNull();
    expect(
      retryDelayMs(new APICallError({ message: "bad", url: "u", requestBodyValues: {}, statusCode: 400 })),
    ).toBeNull();
  });
});

describe("withRateLimit", () => {
  it("waits the suggested delay after a 429 and retries", async () => {
    const clock = fakeClock();
    const inner = scriptedModel([say("hello")]);
    const original = inner.doGenerate;
    let calls = 0;
    inner.doGenerate = async (options) => {
      calls += 1;
      if (calls === 1) throw quotaError('{"retryDelay":"5s"}');
      return original(options);
    };
    const model = withRateLimit(inner, { rpm: 60, now: clock.now, sleep: clock.sleep });
    const result = await generateText({ model, prompt: "hi", maxRetries: 0 });
    expect(result.text).toBe("hello");
    expect(calls).toBe(2);
    expect(clock.waits).toContain(6_000);
  });

  it("gives up on delays longer than maxWaitMs (e.g. a daily quota)", async () => {
    const clock = fakeClock();
    const inner = scriptedModel([]);
    inner.doGenerate = async () => {
      throw quotaError('{"retryDelay":"7200s"}');
    };
    const model = withRateLimit(inner, { rpm: 60, now: clock.now, sleep: clock.sleep, maxWaitMs: 300_000 });
    await expect(generateText({ model, prompt: "hi", maxRetries: 0 })).rejects.toThrow(/quota/);
    expect(clock.waits).toEqual([]);
  });
});
