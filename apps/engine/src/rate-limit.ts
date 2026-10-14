/**
 * Sliding-window limiter, in memory. The engine runs as one process on the VPS (spec A5), so per-process
 * state is enough; a Postgres-backed limiter is the upgrade path if it ever scales out.
 */
type RateLimitOptions =
  | { limitPerMinute: number; now?: () => number; windowMs?: undefined }
  | { limit: number; windowMs: number; now?: () => number };

export function createRateLimiter(options: RateLimitOptions): {
  check(key: string): { ok: true } | { ok: false; retryAfterS: number };
  size(): number;
} {
  const now = options.now ?? Date.now;
  const windowMs = "windowMs" in options && options.windowMs !== undefined ? options.windowMs : 60_000;
  const limit = "limit" in options ? options.limit : options.limitPerMinute;
  const hits = new Map<string, number[]>();
  let lastSweep = 0;

  function sweep(at: number) {
    if (at - lastSweep < windowMs) return;
    lastSweep = at;
    for (const [key, times] of hits) if ((times.at(-1) ?? 0) <= at - windowMs) hits.delete(key);
  }

  return {
    check(key) {
      const at = now();
      sweep(at);
      const times = (hits.get(key) ?? []).filter((time) => time > at - windowMs);
      if (times.length >= limit) {
        hits.set(key, times);
        const oldest = times[0] ?? at;
        return { ok: false, retryAfterS: Math.max(1, Math.ceil((oldest + windowMs - at) / 1000)) };
      }
      times.push(at);
      hits.set(key, times);
      return { ok: true };
    },
    size: () => hits.size,
  };
}
