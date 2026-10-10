import type dns from "node:dns";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
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

describe("requestPinned", () => {
  let server: Server;
  let port: number;
  const hosts: (string | undefined)[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      hosts.push(req.headers.host);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("pinned");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("connects to the vetted address without resolving the hostname again", async () => {
    // pinned.invalid cannot resolve (RFC 6761), so success proves the connection used the given address.
    const response = await requestPinned(
      new URL(`http://pinned.invalid:${port}/policy`),
      { address: "127.0.0.1", family: 4 },
      AbortSignal.timeout(2000),
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("pinned");
    expect(hosts).toEqual([`pinned.invalid:${port}`]);
  });
});
