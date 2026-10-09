import type { LanguageModelV4 } from "@ai-sdk/provider";
import { APICallError, type LanguageModel, wrapLanguageModel } from "ai";

const WINDOW_MS = 60_000;
const DEFAULT_WAIT_MS = 60_000;
/** Longer suggested waits mean a daily quota: waiting would stall the run, so fail the case instead. */
const DEFAULT_MAX_WAIT_MS = 5 * 60_000;
const DEFAULT_MAX_RATE_LIMIT_WAITS = 5;

interface Clock {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Keeps at most `rpm` requests in any 60-second window (free tiers count requests per minute). */
export function createRequestPacer(options: { rpm: number } & Clock): { acquire(): Promise<void> } {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? realSleep;
  const sent: number[] = [];
  return {
    async acquire() {
      for (;;) {
        while (sent.length > 0 && (sent[0] ?? 0) <= now() - WINDOW_MS) sent.shift();
        if (sent.length < options.rpm) {
          sent.push(now());
          return;
        }
        await sleep((sent[0] ?? now()) + WINDOW_MS - now());
      }
    },
  };
}

/** How long a 429 asks us to wait, in ms; null for any other error. */
export function retryDelayMs(error: unknown): number | null {
  if (!APICallError.isInstance(error) || error.statusCode !== 429) return null;
  const fromBody = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(error.responseBody ?? "")?.[1];
  if (fromBody !== undefined) return Math.round(Number(fromBody) * 1000);
  const fromMessage = /retry in (\d+(?:\.\d+)?)\s*s/i.exec(error.message)?.[1];
  if (fromMessage !== undefined) return Math.round(Number(fromMessage) * 1000);
  const header = error.responseHeaders?.["retry-after"];
  if (header !== undefined && /^\d+$/.test(header)) return Number(header) * 1000;
  return DEFAULT_WAIT_MS;
}

export interface RateLimitOptions extends Clock {
  rpm: number;
  maxWaitMs?: number;
  maxRateLimitWaits?: number;
  onWait?: (ms: number) => void;
}

/**
 * Eval-only: paces requests to `rpm` and, on a 429, waits as long as the provider asks, then retries.
 * The AI SDK's own retries back off for seconds, which is too short for per-minute free-tier quotas.
 */
export function withRateLimit(
  model: Exclude<LanguageModel, string>,
  options: RateLimitOptions,
): LanguageModelV4 {
  const sleep = options.sleep ?? realSleep;
  const pacer = createRequestPacer(options);
  const maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const maxWaits = options.maxRateLimitWaits ?? DEFAULT_MAX_RATE_LIMIT_WAITS;
  return wrapLanguageModel({
    model,
    middleware: {
      wrapGenerate: async ({ doGenerate }) => {
        for (let attempt = 0; ; attempt += 1) {
          await pacer.acquire();
          try {
            return await doGenerate();
          } catch (error) {
            const delay = retryDelayMs(error);
            if (delay === null || delay > maxWaitMs || attempt >= maxWaits) throw error;
            // One extra second so the provider's window has really rolled over.
            options.onWait?.(delay + 1000);
            await sleep(delay + 1000);
          }
        }
      },
    },
  });
}
