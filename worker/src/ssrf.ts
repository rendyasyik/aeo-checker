/**
 * SSRF guard for the Worker fetch path (mitigation layer 5).
 *
 * The Cloudflare Workers runtime has no DNS-resolution API, so we cannot
 * resolve a hostname to its A/AAAA records before fetching. Instead we defend
 * with layered checks that catch the realistic attack surface:
 *
 *  - scheme allowlist (http/https only);
 *  - reject literal private / loopback / link-local IP hosts (v4 + v6),
 *    including the cloud-metadata address 169.254.169.254;
 *  - reject obvious internal hostnames (localhost, *.local, *.internal, etc.);
 *  - manual redirect handling: every hop's Location is re-validated with the
 *    same rules, so a public host that 30x-redirects to http://169.254.169.254
 *    is stopped at the hop.
 *
 * This is intentionally strict-by-blocklist for the address space that matters
 * for metadata/SSRF exfiltration. A determined attacker using a public DNS name
 * that resolves to a private IP (DNS rebinding) is only partially mitigated
 * here; Cloudflare's own egress does not sit inside Rendy's private networks,
 * so the metadata endpoint and RFC1918 ranges are the real risk and are blocked
 * both as direct hosts and on every redirect hop.
 */

const PRIVATE_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "metadata",
  "metadata.google.internal",
]);

/** Returns true if `host` is a syntactically valid dotted-quad IPv4 string. */
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
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 127) return true; // loopback 127.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 169 && b === 254) return true; // link-local incl. 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 + 192.0.2.0/24
  if (a >= 224) return true; // multicast + reserved 224.0.0.0/3
  return false;
}

/** Normalize an IPv6 host string (strips surrounding brackets, lowercases). */
function normalizeIpv6(host: string): string {
  let h = host;
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  return h.toLowerCase();
}

/** Reject loopback / ULA / link-local IPv6 and IPv4-mapped private addresses. */
function isPrivateIpv6(host: string): boolean {
  const h = normalizeIpv6(host);
  if (!h.includes(":")) return false; // not IPv6
  if (h === "::1" || h === "::") return true; // loopback / unspecified
  if (h.startsWith("fe80") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) {
    return true; // link-local fe80::/10
  }
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // ULA fc00::/7
  // IPv4-mapped / -embedded (::ffff:a.b.c.d or ::a.b.c.d) — check embedded v4.
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

/**
 * Validate a URL string against the SSRF rules. Called for the top-level target
 * URL and for every redirect Location before the Worker follows it.
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
  // Reject bare-word / suffix hostnames that resolve inside private networks.
  if (
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".localhost") ||
    host.endsWith(".home.arpa") ||
    !host.includes(".") // single-label host (e.g. "router", "intranet")
      && !parseIpv4(host)
      && !host.includes(":")
  ) {
    return { ok: false, reason: "internal_hostname" };
  }

  // Literal IPv4 host.
  const v4 = parseIpv4(host);
  if (v4) {
    if (isPrivateIpv4(v4)) return { ok: false, reason: "private_ipv4" };
    return { ok: true, reason: "ok" };
  }

  // Literal IPv6 host (URL.hostname keeps brackets stripped, but be safe).
  if (host.includes(":") || rawUrl.includes("[")) {
    if (isPrivateIpv6(u.hostname)) return { ok: false, reason: "private_ipv6" };
  }

  return { ok: true, reason: "ok" };
}
