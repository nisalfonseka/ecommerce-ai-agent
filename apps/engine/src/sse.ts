import type { SSEStreamingApi } from "hono/streaming";

export type Emit = (event: string, data: unknown) => void;

/**
 * Serialises SSE writes. Tool hooks fire synchronously while writes are async, so events are chained to keep
 * their order; `flush` waits for all of them.
 */
export function createEmitter(stream: SSEStreamingApi): { emit: Emit; flush(): Promise<void> } {
  let chain: Promise<void> = Promise.resolve();
  return {
    emit(event, data) {
      chain = chain.then(() => stream.writeSSE({ event, data: JSON.stringify(data) })).catch(() => undefined);
    },
    flush: () => chain,
  };
}
