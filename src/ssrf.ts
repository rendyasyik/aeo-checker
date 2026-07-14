/**
 * SSRF guard (mitigation layer 5) — SHARED, RUNTIME-AGNOSTIC source of truth.
 *
 * One guard protects every fetch path: the Cloudflare Worker (web tool), the MCP
 * server (stdio-npm, runs on the developer's machine with real LAN access), the
 * remote worker MCP, and the site-scan discovery/sampling module. The worker
 * re-exports this module and the MCP imports its compiled output, so there is a
 * single behavioural source of truth.
 *
 * This module uses ONLY the Web-standard `URL` API and pure arithmetic. It has
 * no Node-only imports, so it is portable to the Cloudflare Workers runtime as-is.
 * The one capability the guard cannot get from the Workers runtime is DNS
 * resolution (Workers `fetch` does not expose the resolved IP). To keep the core
 * portable, DNS-based validation is OPT-IN via an INJECTED resolver
 * (`validateUrlForFetchAsync` + `resolver`): callers that have a DNS API (Node)
 * can pass one; callers that don't (Workers) simply omit it and rely on the
 * layered synchronous checks below.
 *
 * Layers (defence in depth):
 *  - scheme allowlist (http/https only); every other scheme is rejected
 *    (file:, gopher:, ftp:, data:, ws:, ...);
 *  - reject literal private / loopback / link-local / reserved IP hosts (v4 + v6),
 *    including the cloud-metadata address 169.254.169.254 and 100.64/10 CGNAT;
 *  - NORMALIZE oddly-encoded IPv4 literals (decimal / octal / hex / mixed, e.g.
 *    2130706433, 0177.0.0.1, 0x7f.1, 127.1) BEFORE the private-range check, so a
 *    tricky encoding of a private address cannot slip through;
 *  - IPv6 IPv4-mapped / -embedded addresses (::ffff:a.b.c.d and ::ffff:a9fe:a9fe
 *    hex form) are decoded and the embedded IPv4 is range-checked;
 *  - reject obvious internal hostnames (localhost, *.local, *.internal, single-
 *    label hosts, cloud metadata names);
 *  - redirect handling lives in the shared guarded-fetch (`./guarded-fetch.ts`),
 *    which re-runs THIS validator on every hop's Location so a public host that
 *    30x-redirects to http://169.254.169.254 is stopped at the hop, and caps the
 *    redirect depth;
 *  - OPTIONAL DNS-rebinding check: when a resolver is injected, the hostname's
 *    resolved A/AAAA records are validated against the same IP denylist.
 *
 * Honest limit: without an injected resolver (the Workers case), a public DNS
 * name that resolves to a private IP is only partially mitigated. Cloudflare's
 * egress does not route into RFC1918 space, so the metadata endpoint and private
 * ranges are the real risk and are blocked both as direct hosts and on every
 * redirect hop; the Node MCP, which DOES run inside a real LAN, can inject a
 * resolver for the full DNS-rebinding defence.
 */

const PRIVATE_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
]);

/**
 * Parse a single IPv4 label that may be decimal, octal (leading 0) or hex
 * (0x...). Returns the numeric value or null if it is not a valid label. Used
 * both for canonical dotted-quad octets and for the parts of an oddly-encoded
 * IPv4 literal (RFC 3986 permits only dotted-decimal, but browsers, curl and
 * many HTTP clients still accept the legacy inet_aton forms, so an attacker can
 * write a private address as 0x7f.1 / 0177.0.0.1 / 2130706433). We normalize
 * before range-checking so those cannot bypass the denylist.
 */
function parseIpv4Part(part: string): number | null {
  if (part.length === 0) return null;
  let value: number;
  if (/^0x[0-9a-f]+$/i.test(part)) {
    value = parseInt(part.slice(2), 16); // hex
  } else if (/^0[0-7]+$/.test(part)) {
    value = parseInt(part, 8); // octal
  } else if (/^0$/.test(part)) {
    value = 0;
  } else if (/^[1-9][0-9]*$/.test(part)) {
    value = parseInt(part, 10); // decimal
  } else {
    return null;
  }
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

/**
 * Normalize any legacy inet_aton-style IPv4 literal to a canonical [a,b,c,d].
 * Accepts 1-4 dot-separated parts where each part may be decimal/octal/hex:
 *   - 4 parts: a.b.c.d          (each 0-255)
 *   - 3 parts: a.b.c            (c is a 16-bit tail)
 *   - 2 parts: a.b              (b is a 24-bit tail)
 *   - 1 part:  a                (a is the whole 32-bit address, e.g. 2130706433)
 * Returns the four octets, or null if it is not an IPv4 literal at all.
 */
function normalizeIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length < 1 || parts.length > 4) return null;

  const nums: number[] = [];
  for (const p of parts) {
    const n = parseIpv4Part(p);
    if (n === null) return null;
    nums.push(n);
  }

  // Per inet_aton, the final part absorbs the remaining low-order bytes.
  const last = nums[nums.length - 1] as number;
  const leading = nums.slice(0, -1);

  // Leading parts must each fit in a single octet.
  for (const n of leading) {
    if (n > 255) return null;
  }

  // Max bits the final part may occupy = 32 - 8*leadingCount.
  const tailBits = 32 - 8 * leading.length;
  const tailMax = tailBits >= 32 ? 0xffffffff : 2 ** tailBits - 1;
  if (last > tailMax) return null;

  // Assemble the 32-bit address.
  let addr = 0;
  for (let i = 0; i < leading.length; i++) {
    addr = addr * 256 + (leading[i] as number);
  }
  addr = addr * 2 ** tailBits + last;

  // Unsigned 32-bit split into 4 octets.
  const a = Math.floor(addr / 2 ** 24) & 0xff;
  const b = Math.floor(addr / 2 ** 16) & 0xff;
  const c = Math.floor(addr / 2 ** 8) & 0xff;
  const d = addr & 0xff;
  return [a, b, c, d];
}

/** Strict dotted-decimal IPv4 parse (kept for the embedded-in-IPv6 tail). */
function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    octets.push(n);
  }
  return octets;
}

/** Private / loopback / link-local / reserved IPv4 ranges. */
function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 10) return true; // private 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16.0.0/12
  if (a === 192 && b === 168) return true; // private 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local 169.254/16 incl. 169.254.169.254 metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 (IETF) + 192.0.2.0/24 (TEST-NET-1)
  if (a >= 224) return true; // multicast 224/4 + reserved 240/4
  return false;
}

/** Normalize an IPv6 host string (strips surrounding brackets, lowercases). */
function normalizeIpv6(host: string): string {
  let h = host;
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h.toLowerCase();
}

/**
 * Expand an IPv6 address (handling "::") into its 8 hextet groups, or null if it
 * is not parseable as IPv6. Used to detect the all-zero unspecified address and
 * IPv4-mapped addresses in hex form (::ffff:a9fe:a9fe).
 */
function expandIpv6(h: string): string[] | null {
  if (!h.includes(":")) return null;
  const dbl = h.split("::");
  if (dbl.length > 2) return null;

  const head = dbl[0] ? (dbl[0] as string).split(":") : [];
  const tail = dbl.length === 2 && dbl[1] ? (dbl[1] as string).split(":") : [];

  // If the last group carries an embedded IPv4 (a.b.c.d), turn it into two
  // hextets so the total group count stays 8.
  function toGroups(list: string[]): string[] {
    if (list.length === 0) return list;
    const lastPart = list[list.length - 1] as string;
    if (lastPart.includes(".")) {
      const v4 = parseIpv4(lastPart);
      if (!v4) return list; // let the outer validator reject/allow
      const [a, b, c, d] = v4 as [number, number, number, number];
      const hi = ((a << 8) | b).toString(16);
      const lo = ((c << 8) | d).toString(16);
      return [...list.slice(0, -1), hi, lo];
    }
    return list;
  }

  const headG = toGroups(head);
  const tailG = toGroups(tail);

  if (dbl.length === 1) {
    // No "::" — must already be 8 groups.
    return headG.length === 8 ? headG : null;
  }
  const missing = 8 - (headG.length + tailG.length);
  if (missing < 0) return null;
  return [...headG, ...Array(missing).fill("0"), ...tailG];
}

/** Reject loopback / ULA / link-local IPv6, unspecified, and IPv4-mapped private. */
function isPrivateIpv6(host: string): boolean {
  const h = normalizeIpv6(host);
  if (!h.includes(":")) return false; // not IPv6

  if (h === "::1") return true; // loopback
  if (h === "::") return true; // unspecified (short form)

  if (
    h.startsWith("fe8") ||
    h.startsWith("fe9") ||
    h.startsWith("fea") ||
    h.startsWith("feb")
  ) {
    return true; // link-local fe80::/10
  }
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // ULA fc00::/7

  const groups = expandIpv6(h);
  if (groups && groups.length === 8) {
    const nums = groups.map((g) => parseInt(g || "0", 16));
    // Unspecified ::/128 (all zero groups).
    if (nums.every((n) => n === 0)) return true;
    // Loopback ::1 in any expanded form.
    if (nums.slice(0, 7).every((n) => n === 0) && nums[7] === 1) return true;
    // IPv4-mapped ::ffff:0:0/96 -> validate the embedded IPv4 (last 2 hextets).
    const isMapped =
      nums[0] === 0 &&
      nums[1] === 0 &&
      nums[2] === 0 &&
      nums[3] === 0 &&
      nums[4] === 0 &&
      nums[5] === 0xffff;
    // NAT64 well-known prefix 64:ff9b::/96 also embeds an IPv4 tail.
    const isNat64 = nums[0] === 0x64 && nums[1] === 0xff9b;
    if (isMapped || isNat64) {
      const a = ((nums[6] as number) >> 8) & 0xff;
      const b = (nums[6] as number) & 0xff;
      const c = ((nums[7] as number) >> 8) & 0xff;
      const d = (nums[7] as number) & 0xff;
      if (isPrivateIpv4([a, b, c, d])) return true;
    }
  }

  // Fallback: dotted IPv4 tail on a partially-written address.
  const tail = h.split(":").pop() ?? "";
  if (tail.includes(".")) {
    const v4 = parseIpv4(tail);
    if (v4 && isPrivateIpv4(v4)) return true;
  }
  return false;
}

export interface SsrfCheck {
  ok: boolean;
  reason: string;
}

/** Minimal resolved-address record an injected resolver returns. */
export interface ResolvedAddress {
  /** The literal IP string (v4 dotted-quad or v6). */
  address: string;
  /** 4 for IPv4, 6 for IPv6. */
  family: 4 | 6;
}

/**
 * Injected DNS resolver contract (portable). Node callers can adapt
 * `dns.promises.lookup(host, { all: true })`; Workers callers omit it. The guard
 * never imports a DNS module itself, keeping this file runtime-agnostic.
 */
export type DnsResolver = (host: string) => Promise<ResolvedAddress[]>;

/** Validate a single already-resolved IP literal against the denylist. */
export function validateResolvedIp(address: string, family: 4 | 6): SsrfCheck {
  if (family === 4) {
    const v4 = normalizeIpv4(address) ?? parseIpv4(address);
    if (v4 && isPrivateIpv4(v4)) return { ok: false, reason: "private_ipv4_resolved" };
    return { ok: true, reason: "ok" };
  }
  if (isPrivateIpv6(address)) return { ok: false, reason: "private_ipv6_resolved" };
  return { ok: true, reason: "ok" };
}

/**
 * Validate a URL string against the SSRF rules (synchronous, no DNS). Called for
 * the top-level target URL and for every redirect Location before a hop is
 * followed. Backward-compatible: same signature and reasons as before, plus the
 * hardened IP-encoding normalization.
 */
export function validateUrlForFetch(rawUrl: string): SsrfCheck {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  const scheme = u.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:") {
    return { ok: false, reason: `scheme_not_allowed:${scheme}` };
  }

  const host = u.hostname.toLowerCase();
  if (!host) return { ok: false, reason: "empty_host" };

  if (PRIVATE_HOSTNAMES.has(host)) {
    return { ok: false, reason: "internal_hostname" };
  }

  // Literal IPv6 host first (URL.hostname strips brackets, but be defensive).
  if (host.includes(":") || rawUrl.includes("[")) {
    if (isPrivateIpv6(u.hostname)) return { ok: false, reason: "private_ipv6" };
    // A syntactically IPv6 host that is not private is allowed.
    if (host.includes(":")) return { ok: true, reason: "ok" };
  }

  // Literal IPv4 host — normalize decimal/octal/hex/mixed BEFORE range-check.
  // Only treat the host as an IPv4 literal if every dot-separated label is a
  // number (so real hostnames like "example.com" are not misread as IPv4).
  if (/^[0-9a-fx.]+$/i.test(host) && /[0-9]/.test(host)) {
    const v4 = normalizeIpv4(host);
    if (v4) {
      if (isPrivateIpv4(v4)) return { ok: false, reason: "private_ipv4" };
      return { ok: true, reason: "ok" };
    }
  }

  // Reject bare-word / suffix hostnames that resolve inside private networks.
  if (
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".localhost") ||
    host.endsWith(".home.arpa") ||
    (!host.includes(".") && !host.includes(":")) // single-label host (e.g. "router")
  ) {
    return { ok: false, reason: "internal_hostname" };
  }

  return { ok: true, reason: "ok" };
}

/**
 * Async variant that ADDS an optional DNS-rebinding check on top of the
 * synchronous rules. When `resolver` is provided, the hostname is resolved and
 * EVERY returned A/AAAA record is validated against the IP denylist, so a public
 * DNS name that resolves to a private IP is rejected. When `resolver` is omitted
 * (e.g. the Workers runtime with no DNS API), this is equivalent to
 * `validateUrlForFetch`. Portable: the resolver is injected, never imported here.
 */
export async function validateUrlForFetchAsync(
  rawUrl: string,
  resolver?: DnsResolver,
): Promise<SsrfCheck> {
  const sync = validateUrlForFetch(rawUrl);
  if (!sync.ok) return sync;
  if (!resolver) return sync;

  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  // Literal IPs are already fully validated synchronously; skip DNS.
  if (host.includes(":")) return sync;
  if (/^[0-9a-fx.]+$/i.test(host) && normalizeIpv4(host)) return sync;

  let records: ResolvedAddress[];
  try {
    records = await resolver(host);
  } catch {
    // Resolution failure is not, by itself, an SSRF signal; let the fetch layer
    // surface the real network error. (Fail-open on DNS error, closed on match.)
    return sync;
  }
  if (records.length === 0) return sync;
  for (const rec of records) {
    const check = validateResolvedIp(rec.address, rec.family);
    if (!check.ok) return check;
  }
  return { ok: true, reason: "ok" };
}
