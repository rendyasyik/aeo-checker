/**
 * Node SSRF-guarded fetch for the MCP server.
 *
 * This is the Node twin of the Cloudflare Worker's `makeGuardedFetch`
 * (worker/src/guarded-fetch.ts). It reuses the SAME core-lib SSRF source of
 * truth (`validateUrlForFetch` from ../../dist/ssrf.js) so there is zero
 * behavioural drift between the web tool and the developer MCP surface.
 *
 * SECURE BY DEFAULT (Larry's decision): the guard is ACTIVE by default and
 * blocks private / loopback / link-local / cloud-metadata hosts, both for the
 * entry URL and on every redirect hop. A developer who knowingly wants to scan
 * an internal host (e.g. a localhost dev server) must OPT IN explicitly via the
 * `AEO_ALLOW_PRIVATE_HOSTS=1` env var or the per-call `allowPrivateHosts` flag.
 * When the guard blocks a host the error message is honest and tells the caller
 * exactly which env var flips it.
 *
 * There is intentionally NO Turnstile / rate-limit / circuit-breaker here (those
 * live in the Worker). An MCP server is a LOCAL, single-developer process spoken
 * to over stdio, not a shared public surface, so those abuse mitigations would
 * only add friction. We keep the two that are always correct: an SSRF guard
 * (safety) and a per-fetch timeout + redirect cap (liveness).
 */

import { validateUrlForFetch } from "../../dist/ssrf.js";

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

/**
 * Build a `fetch`-compatible function bound to a guard config, using Node's
 * global `fetch` (Node 22). Redirects are handled manually so each hop is
 * re-validated by the SSRF guard before it is followed, exactly like the Worker.
 */
export function makeNodeGuardedFetch(cfg: GuardedFetchConfig): typeof fetch {
  const guarded = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const startUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    // Entry-URL SSRF check (unless the developer opted out).
    if (!cfg.allowPrivateHosts) {
      const entry = validateUrlForFetch(startUrl);
      if (!entry.ok) {
        throw new Error(`${SSRF_BLOCK_PREFIX}:${entry.reason}: ${SSRF_HINT}`);
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);
    const baseHeaders = new Headers(init?.headers ?? {});

    try {
      let currentUrl = startUrl;
      let hops = 0;
      for (;;) {
        const res = await fetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: baseHeaders,
        });

        // Redirect? Re-validate the next hop before following it.
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get("location");
          if (!loc) return synthResponse(await res.text(), res, currentUrl);
          const nextUrl = new URL(loc, currentUrl).toString();
          if (!cfg.allowPrivateHosts) {
            const hop = validateUrlForFetch(nextUrl);
            if (!hop.ok) {
              throw new Error(
                `${SSRF_BLOCK_PREFIX}_redirect:${hop.reason}: ${SSRF_HINT}`,
              );
            }
          }
          hops += 1;
          if (hops > cfg.maxRedirects) throw new Error("too_many_redirects");
          currentUrl = nextUrl;
          continue;
        }

        return synthResponse(await res.text(), res, currentUrl);
      }
    } finally {
      clearTimeout(timer);
    }
  };
  return guarded as typeof fetch;
}

/**
 * Rebuild a Response the engine can consume, with `url` reflecting the final
 * hop (the engine reads `res.status`, `res.url`, `res.headers`, `res.text()`).
 */
function synthResponse(body: string, res: Response, finalUrl: string): Response {
  const headers = new Headers();
  res.headers.forEach((v, k) => headers.set(k, v));
  const out = new Response(body, { status: res.status, headers });
  try {
    Object.defineProperty(out, "url", { value: finalUrl, configurable: true });
  } catch {
    // If it cannot be overridden the engine falls back to the requested URL.
  }
  return out;
}
