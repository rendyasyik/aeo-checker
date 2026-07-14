/**
 * Shared, RUNTIME-AGNOSTIC guarded-fetch core (mitigation layer 5).
 *
 * Both wrappers of the deterministic engine — the Cloudflare Worker (web tool +
 * remote MCP) and the Node MCP server (stdio-npm) — need the SAME
 * SSRF-guarded, redirect-revalidating fetch. Before this module that loop was
 * copy-pasted into `worker/src/guarded-fetch.ts` and `mcp/src/guarded-fetch.ts`,
 * which drifts over time. The loop now lives HERE and both wrappers delegate to
 * it, passing only their runtime-specific bits via injection:
 *
 *   - `fetchImpl`     the underlying fetch (Workers `fetch` with `cf:` options,
 *                     or Node global `fetch`); the core never references a
 *                     specific runtime's fetch;
 *   - `readBody`      how to read a response body (the Worker caps bytes with a
 *                     streaming reader; Node reads `res.text()`);
 *   - `resolver`      OPTIONAL injected DNS resolver for the DNS-rebinding check
 *                     (Node can supply one; Workers omit it — see ssrf.ts);
 *   - config          `timeoutMs`, `maxRedirects`, `allowPrivateHosts`, and the
 *                     error-message prefixes so each wrapper keeps its own honest
 *                     error text (the Worker throws `ssrf_blocked:*`; the MCP
 *                     appends the `AEO_ALLOW_PRIVATE_HOSTS=1` hint).
 *
 * Uses only Web-standard APIs (fetch, URL, Headers, Response, AbortController),
 * so it compiles and runs unchanged on Workers and Node. Redirects are handled
 * MANUALLY (`redirect: "manual"`): each hop's Location is re-validated with the
 * same SSRF rules before it is followed, and the depth is capped.
 */

import {
  validateUrlForFetch,
  validateUrlForFetchAsync,
  type DnsResolver,
} from "./ssrf.js";

/** Read a response body into text (may cap bytes). */
export type BodyReader = (res: Response) => Promise<string>;

export interface GuardedFetchCoreConfig {
  /** Per-request wall-clock timeout in ms. */
  timeoutMs: number;
  /** Max redirect hops to follow before giving up. */
  maxRedirects: number;
  /**
   * When true the SSRF guard is DISABLED (private/internal hosts allowed). Only
   * a deliberate developer opt-in should set this (Node MCP). The Worker always
   * leaves it false.
   */
  allowPrivateHosts?: boolean;
  /** Underlying fetch to call for each hop (defaults to global `fetch`). */
  fetchImpl?: typeof fetch;
  /** Body reader (defaults to `res.text()`). */
  readBody?: BodyReader;
  /**
   * Optional injected DNS resolver. When present the entry URL and each redirect
   * hop are additionally validated against the resolved IPs (DNS-rebinding
   * defence). Omit on runtimes with no DNS API (Workers).
   */
  resolver?: DnsResolver;
  /** Extra init merged into every underlying fetch call (e.g. Workers `cf:`). */
  fetchInit?: Record<string, unknown>;
  /** Error prefix thrown when the ENTRY url is blocked. Default "ssrf_blocked". */
  blockPrefix?: string;
  /** Error prefix thrown when a REDIRECT hop is blocked. Default "ssrf_blocked_redirect". */
  redirectBlockPrefix?: string;
  /** Optional suffix appended to SSRF error messages (e.g. the MCP opt-in hint). */
  errorSuffix?: string;
}

const DEFAULT_BLOCK_PREFIX = "ssrf_blocked";
const DEFAULT_REDIRECT_BLOCK_PREFIX = "ssrf_blocked_redirect";

/** Default body reader: read the whole body as text. */
async function readTextBody(res: Response): Promise<string> {
  return res.text();
}

/**
 * Rebuild a Response the engine can consume, with `url` reflecting the final hop
 * (the engine reads `res.status`, `res.url`, `res.headers` via forEach, and
 * `res.text()`). `Response.url` is read-only, so we override it via
 * defineProperty; if that fails the engine falls back to the requested URL.
 */
export function synthResponse(
  body: string,
  res: Response,
  finalUrl: string,
): Response {
  const headers = new Headers();
  res.headers.forEach((v, k) => headers.set(k, v));
  const out = new Response(body, { status: res.status, headers });
  try {
    Object.defineProperty(out, "url", { value: finalUrl, configurable: true });
  } catch {
    // Fall back to the requested URL if the override is not permitted.
  }
  return out;
}

/**
 * Build a `fetch`-compatible function bound to a guard config. The returned
 * function supports only the subset of fetch the engine uses (GET-like reads
 * with headers), which is all `fetchRaw` needs. It is injected into the engine
 * as `fetchImpl`, so every subrequest (the page + /robots.txt + /llms.txt +
 * every sampled site page) flows through the same guard.
 */
export function makeGuardedFetchCore(
  cfg: GuardedFetchCoreConfig,
): typeof fetch {
  const {
    timeoutMs,
    maxRedirects,
    allowPrivateHosts = false,
    fetchImpl = fetch,
    readBody = readTextBody,
    resolver,
    fetchInit = {},
    blockPrefix = DEFAULT_BLOCK_PREFIX,
    redirectBlockPrefix = DEFAULT_REDIRECT_BLOCK_PREFIX,
    errorSuffix,
  } = cfg;

  const withSuffix = (msg: string): string =>
    errorSuffix ? `${msg}: ${errorSuffix}` : msg;

  const validate = async (url: string) =>
    resolver ? validateUrlForFetchAsync(url, resolver) : validateUrlForFetch(url);

  const guarded = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const startUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    // Validate the entry URL up front (unless the caller opted out of the guard).
    if (!allowPrivateHosts) {
      const entry = await validate(startUrl);
      if (!entry.ok) {
        throw new Error(withSuffix(`${blockPrefix}:${entry.reason}`));
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const baseHeaders = new Headers(init?.headers ?? {});

    try {
      let currentUrl = startUrl;
      let hops = 0;
      for (;;) {
        const res = await fetchImpl(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: baseHeaders,
          ...fetchInit,
        } as RequestInit);

        // Redirect? Re-validate the next hop before following it.
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get("location");
          if (!loc) {
            // No Location — treat as a terminal (unusual) response.
            const body = await readBody(res);
            return synthResponse(body, res, currentUrl);
          }
          const nextUrl = new URL(loc, currentUrl).toString();
          if (!allowPrivateHosts) {
            const hop = await validate(nextUrl);
            if (!hop.ok) {
              throw new Error(withSuffix(`${redirectBlockPrefix}:${hop.reason}`));
            }
          }
          hops += 1;
          if (hops > maxRedirects) throw new Error("too_many_redirects");
          currentUrl = nextUrl;
          continue;
        }

        const body = await readBody(res);
        return synthResponse(body, res, currentUrl);
      }
    } finally {
      clearTimeout(timer);
    }
  };

  return guarded as typeof fetch;
}
