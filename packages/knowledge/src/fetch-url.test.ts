import { execFileSync, spawnSync } from "node:child_process";
import type dns from "node:dns";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls, { type TLSSocket } from "node:tls";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { KnowledgeSourceError } from "./errors";
import { fetchPublicUrl, isBlockedAddress, requestPinned } from "./fetch-url";

const PUBLIC = "93.184.216.34";

/** dns.lookup stand-in: hostname → addresses; unknown names fail like ENOTFOUND. */
function fakeLookup(table: Record<string, string[]>) {
  const lookup = vi.fn(
    (
      hostname: string,
      _options: unknown,
      callback: (err: Error | null, addresses: { address: string; family: number }[]) => void,
    ) => {
      const addresses = table[hostname];
      if (!addresses) return callback(Object.assign(new Error("not found"), { code: "ENOTFOUND" }), []);
      callback(
        null,
        addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })),
      );
    },
  );
  return lookup as unknown as typeof dns.lookup & typeof lookup;
}

const html = (body: string, init: ResponseInit = {}) =>
  new Response(body, { ...init, headers: { "content-type": "text/html; charset=utf-8", ...init.headers } });

function fakeFetch(responses: Record<string, () => Response | Promise<Response>>) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    const respond = responses[url];
    if (!respond) throw new Error(`unexpected fetch ${url}`);
    return respond();
  });
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof KnowledgeSourceError) return error.code;
    throw error;
  }
  throw new Error("expected a KnowledgeSourceError");
}

describe("isBlockedAddress", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.5",
    "100.64.0.1",
    "100.127.255.255",
    "127.0.0.1",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "::1",
    "::",
    "fc00::1",
    "fdff:ffff::1",
    "fe80::1",
    "febf::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a00:5",
    "0:0:0:0:0:ffff:192.168.0.1",
  ])("blocks %s", (address) => {
    expect(isBlockedAddress(address)).toBe(true);
  });

  it.each([
    PUBLIC,
    "8.8.8.8",
    "100.128.0.1",
    "172.32.0.1",
    "192.169.0.1",
    "2606:4700::1111",
    "::ffff:8.8.8.8",
  ])("allows %s", (address) => {
    expect(isBlockedAddress(address)).toBe(false);
  });

  it("blocks anything that is not an IP address", () => {
    expect(isBlockedAddress("example.com")).toBe(true);
  });
});

describe("fetchPublicUrl", () => {
  const lookup = fakeLookup({
    "shop.example.lk": [PUBLIC],
    "cdn.example.lk": [PUBLIC, "2606:4700::1111"],
    "internal.example.lk": ["10.0.0.5"],
    "mixed.example.lk": [PUBLIC, "192.168.0.10"],
    "v6.example.lk": ["fd00::1"],
  });

  it("refuses loopback, metadata and private addresses before fetching", async () => {
    const fetch = fakeFetch({});
    for (const url of [
      "http://127.0.0.1/",
      "http://169.254.169.254/latest",
      "http://internal.example.lk/policy",
      "http://mixed.example.lk/",
      "http://v6.example.lk/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://2130706433/",
      "http://localhost/",
    ]) {
      const local = fakeLookup({ localhost: ["127.0.0.1"] });
      const resolver = url.includes("localhost") ? local : lookup;
      expect(await codeOf(fetchPublicUrl(url, { lookup: resolver, fetch })), url).toBe("blocked_address");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("re-checks every redirect hop", async () => {
    const fetch = fakeFetch({
      "https://shop.example.lk/policy": () =>
        new Response(null, { status: 302, headers: { location: "http://internal.example.lk/admin" } }),
    });
    expect(await codeOf(fetchPublicUrl("https://shop.example.lk/policy", { lookup, fetch }))).toBe(
      "blocked_address",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("refuses bad schemes, credentials and ports", async () => {
    const fetch = fakeFetch({});
    for (const url of [
      "ftp://shop.example.lk/policy.txt",
      "file:///etc/passwd",
      "https://user:pw@shop.example.lk/",
      "http://shop.example.lk:8080/",
      "not a url",
      "http://unknown.example.lk/",
    ]) {
      expect(await codeOf(fetchPublicUrl(url, { lookup, fetch })), url).toBe("bad_url");
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("re-checks the scheme and port of every redirect hop", async () => {
    for (const location of ["ftp://shop.example.lk/policy.txt", "https://shop.example.lk:8443/policy"]) {
      const fetch = fakeFetch({
        "https://shop.example.lk/policy": () => new Response(null, { status: 302, headers: { location } }),
      });
      expect(
        await codeOf(fetchPublicUrl("https://shop.example.lk/policy", { lookup, fetch })),
        location,
      ).toBe("bad_url");
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("follows up to three public redirects, manually", async () => {
    const fetch = fakeFetch({
      "http://shop.example.lk/a": () =>
        new Response(null, { status: 301, headers: { location: "https://shop.example.lk/b" } }),
      "https://shop.example.lk/b": () => new Response(null, { status: 307, headers: { location: "/c" } }),
      "https://shop.example.lk/c": () =>
        new Response(null, { status: 308, headers: { location: "https://cdn.example.lk:443/d" } }),
      "https://cdn.example.lk/d": () => html("<p>Exchanges within 7 days</p>"),
    });
    const result = await fetchPublicUrl("http://shop.example.lk/a", { lookup, fetch });
    expect(result).toEqual({
      body: "<p>Exchanges within 7 days</p>",
      contentType: "text/html",
      finalUrl: "https://cdn.example.lk/d",
    });
    for (const call of fetch.mock.calls) expect(call[1]).toMatchObject({ redirect: "manual" });
  });

  it("stops after too many redirects", async () => {
    const fetch = vi.fn(
      async () => new Response(null, { status: 302, headers: { location: "http://shop.example.lk/loop" } }),
    );
    expect(await codeOf(fetchPublicUrl("http://shop.example.lk/loop", { lookup, fetch }))).toBe("http_302");
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("refuses bodies over the limit, streamed or declared", async () => {
    const big = "a".repeat(3 * 1024 * 1024);
    const streamed = fakeFetch({ "https://shop.example.lk/big": () => html(big) });
    expect(await codeOf(fetchPublicUrl("https://shop.example.lk/big", { lookup, fetch: streamed }))).toBe(
      "too_large",
    );
    const declared = fakeFetch({
      "https://shop.example.lk/big": () =>
        html("small", { headers: { "content-length": String(big.length) } }),
    });
    expect(await codeOf(fetchPublicUrl("https://shop.example.lk/big", { lookup, fetch: declared }))).toBe(
      "too_large",
    );
  });

  it("accepts only html, plain text and markdown", async () => {
    const pdf = fakeFetch({
      "https://shop.example.lk/p.pdf": () =>
        new Response("%PDF-1.4", { headers: { "content-type": "application/pdf" } }),
    });
    expect(await codeOf(fetchPublicUrl("https://shop.example.lk/p.pdf", { lookup, fetch: pdf }))).toBe(
      "unsupported_type",
    );
    const md = fakeFetch({
      "https://shop.example.lk/p.md": () =>
        new Response("# Returns", { headers: { "content-type": "text/markdown" } }),
    });
    expect(await fetchPublicUrl("https://shop.example.lk/p.md", { lookup, fetch: md })).toMatchObject({
      body: "# Returns",
      contentType: "text/markdown",
    });
  });

  it("maps error statuses to http_<status>", async () => {
    const fetch = fakeFetch({ "https://shop.example.lk/gone": () => html("", { status: 404 }) });
    expect(await codeOf(fetchPublicUrl("https://shop.example.lk/gone", { lookup, fetch }))).toBe("http_404");
  });

  it("times out a hanging server, whether headers or body never arrive", async () => {
    const hangs = vi.fn(() => new Promise<Response>(() => undefined));
    expect(
      await codeOf(fetchPublicUrl("https://shop.example.lk/", { lookup, fetch: hangs, timeoutMs: 50 })),
    ).toBe("timeout");
    const slowBody = fakeFetch({
      "https://shop.example.lk/": () =>
        new Response(new ReadableStream({ start: () => undefined }), {
          headers: { "content-type": "text/plain" },
        }),
    });
    expect(
      await codeOf(fetchPublicUrl("https://shop.example.lk/", { lookup, fetch: slowBody, timeoutMs: 50 })),
    ).toBe("timeout");
  });
});

const LOOPBACK = { address: "127.0.0.1", family: 4 } as const;

describe("requestPinned", () => {
  let server: Server;
  let port: number;
  const seen: { url: string | undefined; host: string | undefined; encoding: string | undefined }[] = [];

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res) => {
      seen.push({ url: req.url, host: req.headers.host, encoding: req.headers["accept-encoding"] });
      if (req.url === "/gzip") {
        res.writeHead(200, { "content-type": "text/plain", "content-encoding": "gzip" });
        res.end(gzipSync("compressed policy"));
      } else if (req.url === "/reset-mid-body") {
        // Headers and part of the body, then the connection drops before content-length is reached.
        res.writeHead(200, { "content-type": "text/plain", "content-length": "100000" });
        res.write("partial policy text");
        setTimeout(() => req.socket.destroy(), 50);
      } else if (req.url === "/reset-before-headers") {
        req.socket.destroy();
      } else {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("pinned");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  /** An injected fetch that answers every public URL from the local server through requestPinned. */
  const pinnedFetch = (input: string | URL | Request, init?: RequestInit) =>
    requestPinned(
      new URL(`http://pinned.invalid:${port}${new URL(String(input)).pathname}`),
      LOOPBACK,
      init?.signal ?? AbortSignal.timeout(2000),
    );
  /** The same through Node's own fetch (undici), whose body errors look different. */
  const undiciFetch = (input: string | URL | Request, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${port}${new URL(String(input)).pathname}`, init);
  const lookup = fakeLookup({ "shop.example.lk": [PUBLIC] });

  it("connects to the vetted address without resolving the hostname again", async () => {
    // pinned.invalid cannot resolve (RFC 6761), so success proves the connection used the given address.
    seen.length = 0;
    const response = await requestPinned(
      new URL(`http://pinned.invalid:${port}/policy`),
      LOOPBACK,
      AbortSignal.timeout(2000),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("pinned");
    expect(seen).toEqual([{ url: "/policy", host: `pinned.invalid:${port}`, encoding: "identity" }]);
  });

  it("refuses a compressed 2xx body as unsupported_type", async () => {
    const direct = requestPinned(
      new URL(`http://pinned.invalid:${port}/gzip`),
      LOOPBACK,
      AbortSignal.timeout(2000),
    );
    expect(await codeOf(direct)).toBe("unsupported_type");
    const viaFetch = fetchPublicUrl("http://shop.example.lk/gzip", { lookup, fetch: pinnedFetch });
    expect(await codeOf(viaFetch)).toBe("unsupported_type");
  });

  it("maps a connection reset in the middle of the body to unreachable", async () => {
    // The raw stream error (ECONNRESET "aborted") is what used to escape as a 500.
    const response = await requestPinned(
      new URL(`http://pinned.invalid:${port}/reset-mid-body`),
      LOOPBACK,
      AbortSignal.timeout(2000),
    );
    expect(response.status).toBe(200);
    const raw = await response.text().then(
      () => null,
      (error: unknown) => error,
    );
    expect(raw).toBeInstanceOf(Error);
    expect(raw).not.toBeInstanceOf(KnowledgeSourceError);

    for (const fetch of [pinnedFetch, undiciFetch]) {
      expect(await codeOf(fetchPublicUrl("http://shop.example.lk/reset-mid-body", { lookup, fetch }))).toBe(
        "unreachable",
      );
      expect(
        await codeOf(fetchPublicUrl("http://shop.example.lk/reset-before-headers", { lookup, fetch })),
      ).toBe("unreachable");
    }
  });
});

const opensslAvailable = spawnSync("openssl", ["version"], { stdio: "ignore" }).status === 0;

// A throwaway self-signed certificate for pinned.invalid, trusted only inside this test file by adding it to
// Node's default CA list (tls.setDefaultCACertificates). requestPinned itself is unchanged: it never takes a CA,
// rejectUnauthorized or checkServerIdentity option, so production verification cannot be loosened.
describe.skipIf(!opensslAvailable)("requestPinned over https", () => {
  let server: HttpsServer;
  let port: number;
  let dir: string;
  let defaultCAs: string[];
  const seen: { servername: string | false | null; host: string | undefined }[] = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "pinned-tls-"));
    const key = join(dir, "key.pem");
    const cert = join(dir, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "ec",
        "-pkeyopt",
        "ec_paramgen_curve:prime256v1",
        "-nodes",
        "-days",
        "1",
        "-subj",
        "/CN=pinned.invalid",
        "-addext",
        "subjectAltName=DNS:pinned.invalid",
        "-keyout",
        key,
        "-out",
        cert,
      ],
      { stdio: "ignore" },
    );
    const certPem = readFileSync(cert, "utf8");
    server = createHttpsServer({ key: readFileSync(key), cert: certPem }, (req, res) => {
      seen.push({ servername: (req.socket as TLSSocket).servername, host: req.headers.host });
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("tls pinned");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
    defaultCAs = tls.getCACertificates("default");
    tls.setDefaultCACertificates([...defaultCAs, certPem]);
  });
  afterAll(async () => {
    if (defaultCAs) tls.setDefaultCACertificates(defaultCAs);
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("connects to the vetted address, with the URL hostname as SNI and Host", async () => {
    const response = await requestPinned(
      new URL(`https://pinned.invalid:${port}/policy`),
      LOOPBACK,
      AbortSignal.timeout(5000),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("tls pinned");
    expect(seen).toEqual([{ servername: "pinned.invalid", host: `pinned.invalid:${port}` }]);
  });

  it("still verifies the certificate against the URL hostname and the trusted CAs", async () => {
    const otherName = requestPinned(
      new URL(`https://other.invalid:${port}/`),
      LOOPBACK,
      AbortSignal.timeout(5000),
    );
    await expect(otherName).rejects.toMatchObject({ code: "ERR_TLS_CERT_ALTNAME_INVALID" });

    tls.setDefaultCACertificates(defaultCAs);
    try {
      const untrusted = requestPinned(
        new URL(`https://pinned.invalid:${port}/`),
        LOOPBACK,
        AbortSignal.timeout(5000),
      );
      await expect(untrusted).rejects.toMatchObject({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" });
    } finally {
      tls.setDefaultCACertificates([...defaultCAs, readFileSync(join(dir, "cert.pem"), "utf8")]);
    }
  });
});
