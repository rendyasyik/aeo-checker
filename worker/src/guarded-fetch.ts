/**
 * Cloudflare Worker guarded fetch — a THIN adapter over the shared core
 * (`src/guarded-fetch.ts`). The SSRF guard, manual redirect re-validation and
 * depth cap all live in the shared core so the Worker and the Node MCP cannot
 * drift. This file keeps only the two Worker-specific bits:
 *
 *   - a byte-capped streaming body reader (`readCapped`, `maxBytes`), so a huge
 *     response cannot exhaust the Worker; and
 *   - the CF-specific `cf: { cacheTtl: 0, cacheEverything: false }` fetch init so
 *     scanned pages are never served from cache and egress stays fresh.
 *
 * It presents the same call surface the engine uses (`fetch(url, init)`) and is
 * injected into the engine as `fetchImpl`. The Workers runtime has no DNS API,
 * so no resolver is injected; the layered synchronous SSRF checks + per-hop
 * redirect re-validation apply (see src/ssrf.ts for the honest DNS-rebinding
 * limit).
 */

import { makeGuardedFetchCore } from "../../src/guarded-fetch.js";

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
 * Build a `fetch`-compatible function bound to a guard config, delegating the
 * SSRF + redirect logic to the shared core and supplying the Worker's
 * byte-capped body reader + CF cache-bypass init.
 */
export function makeGuardedFetch(
  cfg: GuardedFetchConfig = DEFAULT_GUARD,
): typeof fetch {
  return makeGuardedFetchCore({
    timeoutMs: cfg.timeoutMs,
    maxRedirects: cfg.maxRedirects,
    allowPrivateHosts: false, // Worker is a public surface; never opt out.
    readBody: (res) => readCapped(res, cfg.maxBytes),
    // CF-specific: never cache scanned pages; keep egress fresh.
    fetchInit: { cf: { cacheTtl: 0, cacheEverything: false } },
  });
}
