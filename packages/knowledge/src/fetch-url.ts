import dns, { type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { KnowledgeSourceError } from "./errors";

export interface FetchPublicUrlOptions {
  /** Test seam; defaults to dns.lookup. Every address it returns is checked. */
  lookup?: typeof dns.lookup;
  /**
   * Test seam. When omitted (production), each hop connects with requestPinned to the address that passed the
   * check, so DNS cannot change between the check and the connection (rebinding). An injected fetch makes its
   * own connection and is only for tests.
   */
  fetch?: typeof fetch;
  /** Response body cap in bytes (default 2 MB). */
  maxBytes?: number;
  /** For the whole fetch, all redirects and the body included (default 10 s). */
  timeoutMs?: number;
  /** Default 3. */
  maxRedirects?: number;
}

export interface FetchedPage {
  body: string;
  /** Media type without parameters, e.g. "text/html". */
  contentType: string;
  finalUrl: string;
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 3;
const ACCEPTED_TYPES = new Set(["text/html", "text/plain", "text/markdown"]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NULL_BODY_STATUSES = new Set([204, 205, 304]);
const REQUEST_HEADERS = {
  accept: "text/html, text/markdown, text/plain;q=0.9",
  "user-agent": "Mozilla/5.0 (compatible; knowledge-fetcher/1.0)",
};

// IPv4 ranges a merchant-supplied URL must never reach: "this" network, private, carrier-grade NAT, loopback,
// link-local (cloud metadata at 169.254.169.254) and private.
const BLOCKED_V4: readonly [string, number][] = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
];

function v4ToInt(address: string): number {
  return address.split(".").reduce((n, octet) => ((n << 8) | Number(octet)) >>> 0, 0);
}

const BLOCKED_V4_RANGES = BLOCKED_V4.map(([base, prefix]) => ({ base: v4ToInt(base), prefix }));

function blockedV4(n: number): boolean {
  return BLOCKED_V4_RANGES.some(({ base, prefix }) => n >>> (32 - prefix) === base >>> (32 - prefix));
}

/** Eight 16-bit words; the input is already known to be valid IPv6 (net.isIP). */
function v6Words(address: string): number[] {
  let text = (address.split("%")[0] ?? "").toLowerCase();
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1];
  if (dotted) {
    const n = v4ToInt(dotted);
    text = `${text.slice(0, -dotted.length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const front = head === "" ? [] : head.split(":");
  const back = tail === undefined || tail === "" ? [] : tail.split(":");
  const zeros = tail === undefined ? [] : new Array<string>(8 - front.length - back.length).fill("0");
  return [...front, ...zeros, ...back].map((word) => Number.parseInt(word, 16));
}

function blockedV6(words: number[]): boolean {
  const [w0 = 0, w1 = 0, w2 = 0, w3 = 0, w4 = 0, w5 = 0, w6 = 0, w7 = 0] = words;
  const embeddedV4 = ((w6 << 16) | w7) >>> 0;
  const firstFiveZero = w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0;
  if (firstFiveZero && w5 === 0 && w6 === 0 && (w7 === 0 || w7 === 1)) return true; // :: and ::1
  if ((w0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((w0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if (firstFiveZero && w5 === 0xffff) return blockedV4(embeddedV4); // ::ffff:a.b.c.d (IPv4-mapped)
  if (firstFiveZero && w5 === 0) return blockedV4(embeddedV4); // ::a.b.c.d (IPv4-compatible, deprecated)
  if (w0 === 0x64 && w1 === 0xff9b && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) {
    return blockedV4(embeddedV4); // 64:ff9b::/96 NAT64 reaches the embedded IPv4 address
  }
  return false;
}

/** True for addresses in the blocked ranges, and for anything that is not an IP address. */
export function isBlockedAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return blockedV4(v4ToInt(address));
  if (version === 6) return blockedV6(v6Words(address));
  return true;
}

function parsePublicUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new KnowledgeSourceError("bad_url");
  }
  const portOk = url.port === "" || url.port === "80" || url.port === "443";
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username !== "" ||
    url.password !== "" ||
    !portOk ||
    url.hostname === ""
  ) {
    throw new KnowledgeSourceError("bad_url");
  }
  return url;
}

function resolveAll(lookup: typeof dns.lookup, hostname: string): Promise<LookupAddress[]> {
  return new Promise((resolve, reject) => {
    lookup(hostname, { all: true }, (error, addresses) => {
      if (error) reject(error);
      else resolve(addresses);
    });
  });
}

/** Resolves the host and refuses it if ANY address is blocked; returns the address to connect to. */
async function vetHost(url: URL, lookup: typeof dns.lookup): Promise<LookupAddress> {
  const host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  const literal = isIP(host);
  if (literal !== 0) {
    if (isBlockedAddress(host)) throw new KnowledgeSourceError("blocked_address");
    return { address: host, family: literal };
  }
  let addresses: LookupAddress[];
  try {
    addresses = await resolveAll(lookup, host);
  } catch {
    throw new KnowledgeSourceError("bad_url");
  }
  const [first] = addresses;
  if (!first) throw new KnowledgeSourceError("bad_url");
  if (addresses.some((entry) => isBlockedAddress(entry.address))) {
    throw new KnowledgeSourceError("blocked_address");
  }
  return first;
}

/**
 * One GET to `url`, connected to `address` whatever DNS now says for the hostname: the socket's lookup is
 * answered with the vetted address. The URL's hostname is still used for the Host header and for TLS (SNI and
 * certificate verification). agent: false gives every hop a fresh socket, so no pooled connection is reused.
 * Asks for identity encoding and refuses a compressed body (Node's http client does not decompress).
 */
export function requestPinned(url: URL, address: LookupAddress, signal: AbortSignal): Promise<Response> {
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const request = client.request(
      url,
      {
        method: "GET",
        agent: false,
        signal,
        headers: { ...REQUEST_HEADERS, "accept-encoding": "identity" },
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
      },
      (incoming) => {
        try {
          const status = incoming.statusCode ?? 0;
          const encoding = incoming.headers["content-encoding"];
          const compressed = encoding !== undefined && encoding.toLowerCase() !== "identity";
          if (status < 200 || status > 599 || (status < 300 && compressed)) {
            incoming.destroy();
            reject(new KnowledgeSourceError(compressed ? "unsupported_type" : `http_${status}`));
            return;
          }
          const headers = new Headers();
          for (let i = 0; i + 1 < incoming.rawHeaders.length; i += 2) {
            headers.append(incoming.rawHeaders[i] ?? "", incoming.rawHeaders[i + 1] ?? "");
          }
          const body = NULL_BODY_STATUSES.has(status)
            ? null
            : (Readable.toWeb(incoming) as ReadableStream<Uint8Array>);
          resolve(new Response(body, { status, headers }));
        } catch (error) {
          incoming.destroy();
          reject(error);
        }
      },
    );
    request.on("error", reject);
    request.end();
  });
}

/** Rejects with `timeout` once `signal` aborts, even if `promise` ignores the signal. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new KnowledgeSourceError("timeout"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(signal.aborted ? new KnowledgeSourceError("timeout") : error);
      },
    );
  });
}

async function readCapped(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const cancel = () => void reader.cancel().catch(() => undefined);
  signal.addEventListener("abort", cancel, { once: true });
  try {
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        cancel();
        throw new KnowledgeSourceError("too_large");
      }
      parts.push(value);
    }
    return new TextDecoder("utf-8").decode(Buffer.concat(parts));
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}

function discard(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

/**
 * Fetches a merchant-supplied URL without letting it reach the engine's own network: only http(s) on ports
 * 80/443, no credentials, and every address of every hop (redirects are followed manually and re-checked)
 * must be public. Accepts text/html, text/plain and text/markdown up to `maxBytes`.
 * Errors are KnowledgeSourceError; their messages never contain the URL.
 */
export async function fetchPublicUrl(url: string, opts: FetchPublicUrlOptions = {}): Promise<FetchedPage> {
  const lookup = opts.lookup ?? dns.lookup;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const signal = controller.signal;
  try {
    let current = parsePublicUrl(url);
    for (let hop = 0; ; hop++) {
      const address = await untilAborted(vetHost(current, lookup), signal);
      const injected = opts.fetch;
      const request = injected
        ? injected(current.href, { redirect: "manual", signal, headers: REQUEST_HEADERS })
        : requestPinned(current, address, signal);
      let response: Response;
      try {
        response = await untilAborted(request, signal);
      } catch (error) {
        if (error instanceof KnowledgeSourceError) throw error;
        throw new KnowledgeSourceError("unreachable");
      }
      if (REDIRECT_STATUSES.has(response.status)) {
        discard(response);
        const location = response.headers.get("location");
        if (!location || hop >= maxRedirects) throw new KnowledgeSourceError(`http_${response.status}`);
        let next: string;
        try {
          next = new URL(location, current).href;
        } catch {
          throw new KnowledgeSourceError("bad_url");
        }
        current = parsePublicUrl(next);
        continue;
      }
      if (response.status < 200 || response.status > 299) {
        discard(response);
        throw new KnowledgeSourceError(`http_${response.status}`);
      }
      const contentType =
        (response.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
      if (!ACCEPTED_TYPES.has(contentType)) {
        discard(response);
        throw new KnowledgeSourceError("unsupported_type");
      }
      const declared = Number(response.headers.get("content-length") ?? Number.NaN);
      if (Number.isFinite(declared) && declared > maxBytes) {
        discard(response);
        throw new KnowledgeSourceError("too_large");
      }
      const body = await untilAborted(readCapped(response, maxBytes, signal), signal);
      return { body, contentType, finalUrl: current.href };
    }
  } finally {
    clearTimeout(timer);
  }
}
