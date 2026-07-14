import { describe, it, expect } from "vitest";
import {
  validateUrlForFetch,
  validateUrlForFetchAsync,
  validateResolvedIp,
  type DnsResolver,
} from "../src/ssrf.js";
import { makeGuardedFetchCore } from "../src/guarded-fetch.js";

/**
 * SSRF guard test matrix (PR1 gap (b), design §3). Covers every blocked class:
 * private/loopback/link-local/reserved IPv4, cloud metadata, CGNAT, IPv6 (loop-
 * back, ULA, link-local, unspecified, IPv4-mapped), oddly-encoded IPv4
 * (decimal/octal/hex/mixed), non-http(s) schemes, internal hostnames, plus the
 * shared guarded-fetch redirect re-validation and injected-resolver
 * DNS-rebinding defence.
 */

// ---------------------------------------------------------------------------
// Positive: public URLs must pass.
// ---------------------------------------------------------------------------
describe("validateUrlForFetch — public URLs pass", () => {
  const good = [
    "https://example.com/",
    "http://example.com/path?q=1",
    "https://www.rendyandriyanto.com/tools",
    "https://sub.domain.co.id/a/b/c",
    "https://8.8.8.8/", // public IPv4 literal
    "https://[2001:4860:4860::8888]/", // public IPv6 literal (Google DNS)
    "https://1.1.1.1/",
    "https://93.184.216.34/", // example.com's public IP
  ];
  for (const url of good) {
    it(`allows ${url}`, () => {
      const r = validateUrlForFetch(url);
      expect(r.ok, `${url} -> ${r.reason}`).toBe(true);
    });
  }
});

// ---------------------------------------------------------------------------
// Negative class: private / loopback / link-local / reserved IPv4.
// ---------------------------------------------------------------------------
describe("validateUrlForFetch — private/reserved IPv4 blocked", () => {
  const cases: Array<[string, string]> = [
    ["http://10.0.0.1/", "10/8"],
    ["http://10.255.255.255/", "10/8 top"],
    ["http://172.16.0.1/", "172.16/12 low"],
    ["http://172.31.255.255/", "172.16/12 high"],
    ["http://192.168.1.1/", "192.168/16"],
    ["http://127.0.0.1/", "loopback 127/8"],
    ["http://127.1.2.3/", "loopback 127/8"],
    ["http://0.0.0.0/", "0/8 this-network"],
    ["http://0.1.2.3/", "0/8"],
    ["http://169.254.1.1/", "169.254/16 link-local"],
    ["http://169.254.169.254/latest/meta-data", "cloud metadata"],
    ["http://100.64.0.1/", "CGNAT 100.64/10 low"],
    ["http://100.127.255.255/", "CGNAT 100.64/10 high"],
    ["http://192.0.2.10/", "TEST-NET-1 192.0.2/24"],
    ["http://224.0.0.1/", "multicast 224/4"],
    ["http://255.255.255.255/", "broadcast/reserved"],
  ];
  for (const [url, label] of cases) {
    it(`blocks ${url} (${label})`, () => {
      const r = validateUrlForFetch(url);
      expect(r.ok, `${url} should be blocked`).toBe(false);
    });
  }

  // Guard boundary: 172.15 and 172.32 are PUBLIC (outside /12).
  it("allows 172.15.0.1 and 172.32.0.1 (outside 172.16/12)", () => {
    expect(validateUrlForFetch("http://172.15.0.1/").ok).toBe(true);
    expect(validateUrlForFetch("http://172.32.0.1/").ok).toBe(true);
  });
  it("allows 100.63.x and 100.128.x (outside CGNAT 100.64/10)", () => {
    expect(validateUrlForFetch("http://100.63.0.1/").ok).toBe(true);
    expect(validateUrlForFetch("http://100.128.0.1/").ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Negative class: oddly-encoded IPv4 that resolves to a private address.
// ---------------------------------------------------------------------------
describe("validateUrlForFetch — encoded IPv4 normalized then blocked", () => {
  const cases: Array<[string, string]> = [
    ["http://2130706433/", "decimal 127.0.0.1"],
    ["http://017700000001/", "octal 127.0.0.1"],
    ["http://0x7f000001/", "hex 127.0.0.1"],
    ["http://0x7f.0x0.0x0.0x1/", "dotted hex 127.0.0.1"],
    ["http://0177.0.0.1/", "mixed octal 127.0.0.1"],
    ["http://127.1/", "short form 127.0.0.1"],
    ["http://127.0.1/", "3-part 127.0.0.1"],
    ["http://2852039166/", "decimal 169.254.169.254 metadata"],
    ["http://0xA9FEA9FE/", "hex 169.254.169.254 metadata"],
    ["http://3232235521/", "decimal 192.168.0.1"],
    ["http://0x0a000001/", "hex 10.0.0.1"],
  ];
  for (const [url, label] of cases) {
    it(`blocks ${url} (${label})`, () => {
      const r = validateUrlForFetch(url);
      expect(r.ok, `${url} should normalize to private and be blocked`).toBe(false);
    });
  }

  it("decimal 2852039166 == 169.254.169.254 (metadata) is blocked", () => {
    // Sanity that the normalization maths is right.
    expect(validateUrlForFetch("http://2852039166/").reason).toContain("private_ipv4");
  });

  it("allows an encoded PUBLIC address (0x08080808 == 8.8.8.8)", () => {
    expect(validateUrlForFetch("http://0x08080808/").ok).toBe(true);
    expect(validateUrlForFetch("http://134744072/").ok).toBe(true); // 8.8.8.8 decimal
  });
});

// ---------------------------------------------------------------------------
// Negative class: IPv6 loopback / ULA / link-local / unspecified / mapped.
// ---------------------------------------------------------------------------
describe("validateUrlForFetch — private IPv6 blocked", () => {
  const cases: Array<[string, string]> = [
    ["http://[::1]/", "loopback ::1"],
    ["http://[0:0:0:0:0:0:0:1]/", "loopback expanded"],
    ["http://[::]/", "unspecified ::"],
    ["http://[0:0:0:0:0:0:0:0]/", "unspecified expanded"],
    ["http://[fc00::1]/", "ULA fc00::/7"],
    ["http://[fd12:3456::1]/", "ULA fd.."],
    ["http://[fe80::1]/", "link-local fe80::/10"],
    ["http://[fe80::abcd:1234]/", "link-local"],
    ["http://[::ffff:127.0.0.1]/", "IPv4-mapped loopback (dotted)"],
    ["http://[::ffff:169.254.169.254]/", "IPv4-mapped metadata (dotted)"],
    ["http://[::ffff:a9fe:a9fe]/", "IPv4-mapped metadata (hex)"],
    ["http://[::ffff:0a00:0001]/", "IPv4-mapped 10.0.0.1 (hex)"],
    ["http://[64:ff9b::7f00:1]/", "NAT64 127.0.0.1"],
  ];
  for (const [url, label] of cases) {
    it(`blocks ${url} (${label})`, () => {
      const r = validateUrlForFetch(url);
      expect(r.ok, `${url} should be blocked`).toBe(false);
    });
  }

  it("allows a public IPv4-mapped address (::ffff:8.8.8.8)", () => {
    expect(validateUrlForFetch("http://[::ffff:8.8.8.8]/").ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Negative class: non-http(s) schemes.
// ---------------------------------------------------------------------------
describe("validateUrlForFetch — non-http(s) schemes rejected", () => {
  const cases = [
    "file:///etc/passwd",
    "gopher://127.0.0.1:6379/_INFO",
    "ftp://example.com/file",
    "data:text/plain;base64,aGVsbG8=",
    "ws://example.com/socket",
    "wss://example.com/socket",
    "ldap://127.0.0.1/",
    "dict://127.0.0.1:11211/",
    "jar:http://example.com/a!/b",
  ];
  for (const url of cases) {
    it(`rejects ${url}`, () => {
      const r = validateUrlForFetch(url);
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/scheme_not_allowed|invalid_url/);
    });
  }
});

// ---------------------------------------------------------------------------
// Negative class: internal / non-resolvable hostnames.
// ---------------------------------------------------------------------------
describe("validateUrlForFetch — internal hostnames blocked", () => {
  const cases = [
    "http://localhost/",
    "http://localhost:8080/admin",
    "http://LOCALHOST/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://foo.internal/",
    "http://printer.local/",
    "http://box.home.arpa/",
    "http://app.localhost/",
    "http://router/", // single-label host
    "http://intranet/",
  ];
  for (const url of cases) {
    it(`blocks ${url}`, () => {
      expect(validateUrlForFetch(url).ok).toBe(false);
    });
  }
});

describe("validateUrlForFetch — malformed input", () => {
  it("rejects a non-URL string", () => {
    expect(validateUrlForFetch("not a url").ok).toBe(false);
  });
  it("rejects empty string", () => {
    expect(validateUrlForFetch("").ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// validateResolvedIp: direct IP-literal denylist check (used by DNS rebinding).
// ---------------------------------------------------------------------------
describe("validateResolvedIp", () => {
  it("blocks a resolved private IPv4", () => {
    expect(validateResolvedIp("169.254.169.254", 4).ok).toBe(false);
    expect(validateResolvedIp("10.1.2.3", 4).ok).toBe(false);
    expect(validateResolvedIp("127.0.0.1", 4).ok).toBe(false);
  });
  it("allows a resolved public IPv4", () => {
    expect(validateResolvedIp("8.8.8.8", 4).ok).toBe(true);
  });
  it("blocks a resolved private IPv6", () => {
    expect(validateResolvedIp("::1", 6).ok).toBe(false);
    expect(validateResolvedIp("fc00::1", 6).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DNS rebinding: a PUBLIC hostname that resolves to a private IP is rejected.
// ---------------------------------------------------------------------------
describe("validateUrlForFetchAsync — DNS rebinding via injected resolver", () => {
  it("blocks a public hostname resolving to cloud metadata IP", async () => {
    const resolver: DnsResolver = async () => [
      { address: "169.254.169.254", family: 4 },
    ];
    const r = await validateUrlForFetchAsync("http://rebind.attacker.example/", resolver);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("resolved");
  });

  it("blocks a public hostname resolving to an RFC1918 IP", async () => {
    const resolver: DnsResolver = async () => [{ address: "10.0.0.5", family: 4 }];
    const r = await validateUrlForFetchAsync("http://internal-thing.example/", resolver);
    expect(r.ok).toBe(false);
  });

  it("blocks a public hostname resolving to a private IPv6", async () => {
    const resolver: DnsResolver = async () => [{ address: "fc00::1", family: 6 }];
    const r = await validateUrlForFetchAsync("http://v6rebind.example/", resolver);
    expect(r.ok).toBe(false);
  });

  it("allows a public hostname resolving to a public IP", async () => {
    const resolver: DnsResolver = async () => [{ address: "93.184.216.34", family: 4 }];
    const r = await validateUrlForFetchAsync("http://example.com/", resolver);
    expect(r.ok).toBe(true);
  });

  it("with no resolver is equivalent to the sync validator", async () => {
    expect((await validateUrlForFetchAsync("http://example.com/")).ok).toBe(true);
    expect((await validateUrlForFetchAsync("http://10.0.0.1/")).ok).toBe(false);
  });

  it("still blocks synchronously (scheme) before touching the resolver", async () => {
    let called = false;
    const resolver: DnsResolver = async () => {
      called = true;
      return [];
    };
    const r = await validateUrlForFetchAsync("file:///etc/passwd", resolver);
    expect(r.ok).toBe(false);
    expect(called).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Shared guarded-fetch: redirect re-validation + depth cap + DNS rebinding.
// ---------------------------------------------------------------------------

/** Build a mock fetch that serves a route table and honours redirects (302). */
function mockFetch(
  routes: Record<
    string,
    { status?: number; body?: string; location?: string; headers?: Record<string, string> }
  >,
): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const hit = routes[url];
    if (!hit) {
      const r = new Response("not found", { status: 404 });
      Object.defineProperty(r, "url", { value: url, configurable: true });
      return r;
    }
    const headers = new Headers(hit.headers ?? {});
    if (hit.location) headers.set("location", hit.location);
    const res = new Response(hit.body ?? "", {
      status: hit.status ?? (hit.location ? 302 : 200),
      headers,
    });
    Object.defineProperty(res, "url", { value: url, configurable: true });
    return res;
  }) as typeof fetch;
}

describe("makeGuardedFetchCore — redirect re-validation", () => {
  it("blocks a public URL that 302-redirects to 169.254.169.254 (metadata)", async () => {
    const fetchImpl = mockFetch({
      "https://public.example/redirect": {
        location: "http://169.254.169.254/latest/meta-data",
      },
    });
    const gf = makeGuardedFetchCore({ timeoutMs: 2000, maxRedirects: 5, fetchImpl });
    await expect(gf("https://public.example/redirect")).rejects.toThrow(
      /ssrf_blocked_redirect/,
    );
  });

  it("blocks a public URL that 302-redirects to a 10.x host", async () => {
    const fetchImpl = mockFetch({
      "https://public.example/go": { location: "http://10.0.0.9/secret" },
    });
    const gf = makeGuardedFetchCore({ timeoutMs: 2000, maxRedirects: 5, fetchImpl });
    await expect(gf("https://public.example/go")).rejects.toThrow(
      /ssrf_blocked_redirect/,
    );
  });

  it("blocks a redirect that switches to a forbidden scheme (file:)", async () => {
    const fetchImpl = mockFetch({
      "https://public.example/x": { location: "file:///etc/passwd" },
    });
    const gf = makeGuardedFetchCore({ timeoutMs: 2000, maxRedirects: 5, fetchImpl });
    await expect(gf("https://public.example/x")).rejects.toThrow(
      /ssrf_blocked_redirect/,
    );
  });

  it("blocks a redirect chain to an encoded private IP (decimal 127.0.0.1)", async () => {
    const fetchImpl = mockFetch({
      "https://public.example/a": { location: "https://public.example/b" },
      "https://public.example/b": { location: "http://2130706433/" },
    });
    const gf = makeGuardedFetchCore({ timeoutMs: 2000, maxRedirects: 5, fetchImpl });
    await expect(gf("https://public.example/a")).rejects.toThrow(
      /ssrf_blocked_redirect/,
    );
  });

  it("follows a benign public->public redirect and returns the final body", async () => {
    const fetchImpl = mockFetch({
      "https://public.example/from": { location: "https://public.example/to" },
      "https://public.example/to": { body: "<html>ok</html>", status: 200 },
    });
    const gf = makeGuardedFetchCore({ timeoutMs: 2000, maxRedirects: 5, fetchImpl });
    const res = await gf("https://public.example/from");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("ok");
    expect(res.url).toBe("https://public.example/to");
  });

  it("caps redirect depth (too_many_redirects)", async () => {
    const routes: Record<string, { location: string }> = {};
    for (let i = 0; i < 10; i++) {
      routes[`https://public.example/${i}`] = {
        location: `https://public.example/${i + 1}`,
      };
    }
    const gf = makeGuardedFetchCore({
      timeoutMs: 2000,
      maxRedirects: 3,
      fetchImpl: mockFetch(routes),
    });
    await expect(gf("https://public.example/0")).rejects.toThrow(/too_many_redirects/);
  });

  it("blocks the ENTRY url before any fetch", async () => {
    let fetched = false;
    const fetchImpl = (async () => {
      fetched = true;
      return new Response("", { status: 200 });
    }) as typeof fetch;
    const gf = makeGuardedFetchCore({ timeoutMs: 2000, maxRedirects: 5, fetchImpl });
    await expect(gf("http://169.254.169.254/")).rejects.toThrow(/ssrf_blocked:/);
    expect(fetched).toBe(false);
  });

  it("allowPrivateHosts=true bypasses the guard (entry + redirect)", async () => {
    const fetchImpl = mockFetch({
      "http://127.0.0.1/dev": { body: "local ok", status: 200 },
    });
    const gf = makeGuardedFetchCore({
      timeoutMs: 2000,
      maxRedirects: 5,
      allowPrivateHosts: true,
      fetchImpl,
    });
    const res = await gf("http://127.0.0.1/dev");
    expect(res.status).toBe(200);
  });

  it("uses an injected resolver to block a rebinding hostname at fetch time", async () => {
    const fetchImpl = mockFetch({
      "http://rebind.example/": { body: "should never be read", status: 200 },
    });
    const resolver: DnsResolver = async () => [
      { address: "169.254.169.254", family: 4 },
    ];
    const gf = makeGuardedFetchCore({
      timeoutMs: 2000,
      maxRedirects: 5,
      fetchImpl,
      resolver,
    });
    await expect(gf("http://rebind.example/")).rejects.toThrow(/ssrf_blocked/);
  });
});
