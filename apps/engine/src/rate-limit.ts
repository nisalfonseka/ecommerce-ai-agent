const WINDOW_MS = 60_000;

/**
 * Sliding-window limiter, in memory. The engine runs as one process on the VPS (spec A5), so per-process
 * state is enough; a Postgres-backed limiter is the upgrade path if it ever scales out.
 */
export function createRateLimiter(options: { limitPerMinute: number; now?: () => number }): {
  check(key: string): { ok: true } | { ok: false; retryAfterS: number };
  size(): number;
} {
  const now = options.now ?? Date.now;
  const hits = new Map<string, number[]>();
  let lastSweep = 0;

  function sweep(at: number) {
    if (at - lastSweep < WINDOW_MS) return;
    lastSweep = at;
    for (const [key, times] of hits) if ((times.at(-1) ?? 0) <= at - WINDOW_MS) hits.delete(key);
  }

  return {
    check(key) {
      const at = now();
      sweep(at);
      const times = (hits.get(key) ?? []).filter((time) => time > at - WINDOW_MS);
      if (times.length >= options.limitPerMinute) {
        hits.set(key, times);
        const oldest = times[0] ?? at;
        return { ok: false, retryAfterS: Math.max(1, Math.ceil((oldest + WINDOW_MS - at) / 1000)) };
      }
      times.push(at);
      hits.set(key, times);
      return { ok: true };
    },
    size: () => hits.size,
  };
}
