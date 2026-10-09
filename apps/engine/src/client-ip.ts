/**
 * The client address as seen by the outermost trusted proxy. Each proxy appends the address it received from,
 * so with `hops` trusted proxies the client is the hops-th entry from the right. Entries further left are
 * client-controlled and ignored.
 */
export function clientIp(forwardedFor: string | undefined, remoteAddress: string, hops: number): string {
  if (hops <= 0 || !forwardedFor) return remoteAddress;
  const chain = forwardedFor
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  return chain[chain.length - hops] ?? chain[0] ?? remoteAddress;
}
