/**
 * Node SSRF-guarded fetch for the MCP server — a THIN adapter over the shared
 * core (`src/guarded-fetch.ts`, compiled to `../../dist/guarded-fetch.js`).
 *
 * The SSRF guard, per-hop redirect re-validation and depth cap all live in the
 * shared core, so the stdio MCP and the Cloudflare Worker cannot drift. This
 * file keeps only the MCP-specific policy:
 *
 *   - SECURE BY DEFAULT (Larry's decision): the guard is ACTIVE and blocks
 *     private / loopback / link-local / cloud-metadata hosts on the entry URL and
 *     every redirect hop. A developer who knowingly wants to scan an internal
 *     host (e.g. a localhost dev server) must OPT IN via AEO_ALLOW_PRIVATE_HOSTS=1
 *     or the per-call `allowPrivateHosts` flag. Blocked errors carry an honest
 *     hint telling the caller which env var flips it.
 *   - DNS-rebinding defence: because the MCP runs on the developer's own machine
 *     with real LAN access, we inject a Node DNS resolver so a public hostname
 *     that RESOLVES to a private IP is rejected too (the Worker cannot do this —
 *     Workers has no DNS API). The resolver is injectable for tests.
 *
 * There is intentionally NO Turnstile / rate-limit / circuit-breaker here (those
 * live in the Worker). An MCP server is a LOCAL, single-developer stdio process,
 * not a shared public surface, so those abuse mitigations would only add
 * friction. We keep the two that are always correct: the SSRF guard (safety) and
 * a per-fetch timeout + redirect cap (liveness).
 */

import { lookup } from "node:dns/promises";
import {
  makeGuardedFetchCore,
  type BodyReader,
} from "../../dist/guarded-fetch.js";
import type { DnsResolver } from "../../dist/ssrf.js";

/** Sentinel prefix so callers can detect an SSRF block and message honestly. */
export const SSRF_BLOCK_PREFIX = "ssrf_blocked";

/** Human-facing hint appended when the guard blocks a host. */
export const SSRF_HINT =
  "blocked private/internal host; set AEO_ALLOW_PRIVATE_HOSTS=1 to allow";

export interface GuardedFetchConfig {
  /** Per-request wall-clock timeout in ms. */
  timeoutMs: number;
  /** Max redirect hops to follow before giving up. */
  maxRedirects: number;
  /**
   * When true, the SSRF guard is DISABLED (private/internal hosts allowed).
   * Default false = secure. Set only via explicit developer opt-in.
   */
  allowPrivateHosts: boolean;
  /**
   * Optional DNS resolver override (tests inject a mock). When omitted, a real
   * Node `dns.lookup(host, { all: true })` resolver is used for the
   * DNS-rebinding check.
   */
  resolver?: DnsResolver;
}

export const DEFAULT_GUARD: GuardedFetchConfig = {
  timeoutMs: 12_000,
  maxRedirects: 5,
  allowPrivateHosts: false,
};

/**
 * Resolve the effective `allowPrivateHosts` setting: an explicit per-call flag
 * wins; otherwise fall back to the `AEO_ALLOW_PRIVATE_HOSTS=1` env var; default
 * secure (false).
 */
export function resolveAllowPrivateHosts(perCall?: boolean): boolean {
  if (perCall === true) return true;
  if (perCall === false) return false;
  return process.env.AEO_ALLOW_PRIVATE_HOSTS === "1";
}

/** Real Node DNS resolver: all A/AAAA records for a hostname. */
export const nodeDnsResolver: DnsResolver = async (host: string) => {
  const records = await lookup(host, { all: true });
  return records.map((r) => ({
    address: r.address,
    family: r.family === 6 ? 6 : 4,
  }));
};

/**
 * Build a `fetch`-compatible function bound to a guard config, delegating the
 * SSRF + redirect logic to the shared core. Uses Node's global `fetch` and, when
 * the guard is active, an injected DNS resolver so a public hostname that
 * resolves to a private IP is rejected (DNS-rebinding defence).
 */
export function makeNodeGuardedFetch(cfg: GuardedFetchConfig): typeof fetch {
  const readBody: BodyReader = (res) => res.text();
  return makeGuardedFetchCore({
    timeoutMs: cfg.timeoutMs,
    maxRedirects: cfg.maxRedirects,
    allowPrivateHosts: cfg.allowPrivateHosts,
    readBody,
    // Only wire the resolver when the guard is active; opting out disables it too.
    resolver: cfg.allowPrivateHosts
      ? undefined
      : (cfg.resolver ?? nodeDnsResolver),
    blockPrefix: SSRF_BLOCK_PREFIX,
    redirectBlockPrefix: `${SSRF_BLOCK_PREFIX}_redirect`,
    errorSuffix: SSRF_HINT,
  });
}
