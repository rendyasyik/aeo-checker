/**
 * A hardened `fetch` implementation injected into the aeo-checker engine as
 * `fetchImpl` (mitigation layer 5). Every subrequest the engine makes (the page
 * itself plus /robots.txt and /llms.txt) flows through this, so the SSRF guard,
 * timeout, redirect validation and response-size cap apply uniformly.
 *
 * It presents the same call surface the engine uses: `fetch(url, init)` where
 * `init` may carry headers + signal. Redirects are handled manually
 * (`redirect: "manual"`) so each hop's Location is re-validated before we follow
 * it; a public host that 30x-redirects toward an internal address is stopped.
 */

import { validateUrlForFetch } from "./ssrf.js";

export interface GuardedFetchConfig {
  /** Per-request wall-clock timeout in ms. */
  timeoutMs: number;
  /** Hard cap on bytes read from any single response body. */
  maxBytes: number;
  /** Max redirect hops to follow before giving up. */
  maxRedirects: number;
}

export const DEFAULT_GUARD: GuardedFetchConfig = {
  timeoutMs: 9000,
  maxBytes: 3 * 1024 * 1024, // 3 MB
  maxRedirects: 5,
};

/** Read a response body but stop after `maxBytes`, returning truncated text. */
async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const body = res.body;
  if (!body) {
    const txt = await res.text();
    return txt.length > maxBytes ? txt.slice(0, maxBytes) : txt;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        chunks.push(value);
        total += value.byteLength;
        if (total >= maxBytes) break;
      }
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // ignore
    }
  }
  const merged = new Uint8Array(Math.min(total, maxBytes));
  let offset = 0;
  for (const c of chunks) {
    if (offset >= merged.length) break;
    const take = Math.min(c.byteLength, merged.length - offset);
    merged.set(c.subarray(0, take), offset);
    offset += take;
  }
  return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(
    merged,
  );
}

/**
 * Build a `fetch`-compatible function bound to a guard config. The returned
 * function only supports the subset of fetch the engine uses (GET-like reads
 * with headers), which is all `fetchRaw` needs.
 */
export function makeGuardedFetch(
  cfg: GuardedFetchConfig = DEFAULT_GUARD,
): typeof fetch {
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

    // Validate the entry URL up front.
    const entry = validateUrlForFetch(startUrl);
    if (!entry.ok) {
      throw new Error(`ssrf_blocked:${entry.reason}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

    // Preserve the engine's headers; force manual redirect handling.
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
          // CF-specific: never cache scanned pages; keep egress fresh.
          cf: { cacheTtl: 0, cacheEverything: false } as RequestInit["cf"],
        });

        // Redirect? Validate the next hop before following.
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get("location");
          if (!loc) {
            // No Location — treat as a terminal (unusual) response.
            const body = await readCapped(res, cfg.maxBytes);
            return synthResponse(body, res, currentUrl);
          }
          const nextUrl = new URL(loc, currentUrl).toString();
          const hop = validateUrlForFetch(nextUrl);
          if (!hop.ok) {
            throw new Error(`ssrf_blocked_redirect:${hop.reason}`);
          }
          hops += 1;
          if (hops > cfg.maxRedirects) {
            throw new Error("too_many_redirects");
          }
          currentUrl = nextUrl;
          continue;
        }

        const body = await readCapped(res, cfg.maxBytes);
        return synthResponse(body, res, currentUrl);
      }
    } finally {
      clearTimeout(timer);
    }
  };
  return guarded as typeof fetch;
}

/**
 * Rebuild a Response the engine can consume: the engine reads `res.status`,
 * `res.url`, `res.headers` (via forEach) and `res.text()`. We hand back a plain
 * Response whose `url` reflects the final hop.
 */
function synthResponse(body: string, res: Response, finalUrl: string): Response {
  const headers = new Headers();
  res.headers.forEach((v, k) => headers.set(k, v));
  const out = new Response(body, { status: res.status, headers });
  // `Response.url` is read-only; override via defineProperty so the engine's
  // `res.url || url` sees the true final URL after redirects.
  try {
    Object.defineProperty(out, "url", { value: finalUrl, configurable: true });
  } catch {
    // If it cannot be overridden, the engine falls back to the requested URL.
  }
  return out;
}
