/**
 * AEO Tool — Cloudflare Worker (Phase 2).
 *
 * Wraps the runtime-agnostic aeo-checker engine behind a single JSON endpoint,
 * POST /scan, with seven layers of abuse mitigation applied in cheap-to-costly
 * order so obviously-bad traffic is rejected before it can spend resources:
 *
 *   1. CORS locked to rendyandriyanto.com (never "*"), + Referer sanity check.
 *   2. Turnstile invisible-token verification (before any target fetch).
 *   3. Per-IP per-minute rate limit (native Workers rate-limit binding, 10/60s).
 *   4. Per-IP daily quota (~100/day) via KV.
 *   5. SSRF-guarded fetch (injected into the engine as fetchImpl): scheme
 *      allowlist, private/loopback/link-local/metadata IP block, per-hop
 *      redirect validation, 9s timeout, 3 MB body cap.
 *   6. Input hygiene: exactly one valid URL <= 2048 chars; method/route gating.
 *   7. Global daily circuit breaker via KV (503 "busy" instead of blowing the
 *      free tier).
 *
 * The Worker exposes ONLY JSON (no HTML surface to index) plus GET /health.
 *
 * Fase 3, Step 2 adds POST /scan-site (see handleScanSite): the same guards,
 * plus a STRICTER site-scan rate limit and a WEIGHTED daily circuit breaker
 * (one site-scan consumes N units, where N = pages sampled). It returns the RAW
 * orchestrator output; site-level score aggregation is deferred (pending Alison).
 */

import { analyzeUrl } from "../../src/index.js";
import { siteScan } from "../../src/site-scan/index.js";
import { makeGuardedFetch, DEFAULT_GUARD } from "./guarded-fetch.js";
import { verifyTurnstile } from "./turnstile.js";
import { corsHeaders, isOriginAllowed } from "./cors.js";
import {
  checkAndBumpQuotas,
  peekQuotas,
  canAbsorb,
  bumpQuotasBy,
  type CounterEnv,
} from "./counters.js";
import { validateUrlForFetch } from "./ssrf.js";

interface RateLimiter {
  limit: (o: { key: string }) => Promise<{ success: boolean }>;
}

export interface Env extends CounterEnv {
  /** Turnstile secret key (Worker secret; NEVER hardcoded). */
  TURNSTILE_SECRET: string;
  /** Comma-separated extra allowed origins (dev/preview). Optional. */
  ALLOWED_ORIGINS?: string;
  /** Native per-IP per-minute rate limiter binding (for POST /scan). */
  RATE_LIMITER: RateLimiter;
  /** Stricter per-IP per-minute rate limiter binding (for POST /scan-site). */
  SITE_RATE_LIMITER: RateLimiter;
}

const MAX_URL_LEN = 2048;

/**
 * Whole-request wall-clock budget for a site-scan. A site-scan fans out to up
 * to MAX_TOTAL_PAGES single-page scans (each with its own 9s guarded-fetch
 * timeout) at concurrency 4, so we cap the ORCHESTRATOR here well under the
 * Worker CPU/subrequest envelope. On timeout we return an honest 504 rather
 * than a misleading partial. Tune here.
 */
const SITE_SCAN_TIMEOUT_MS = 55_000;
/** Fetch concurrency for per-page scans inside a site-scan. Tune here. */
const SITE_SCAN_CONCURRENCY = 4;

function json(
  body: unknown,
  status: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // JSON API only; keep it out of any index and off of shared caches.
      "x-robots-tag": "noindex, nofollow",
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function clientIp(req: Request): string {
  return req.headers.get("cf-connecting-ip") ?? "0.0.0.0";
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get("origin");
    const cors = corsHeaders(origin, env);

    // --- CORS preflight ---
    if (request.method === "OPTIONS") {
      // For a disallowed origin, corsHeaders omits ACAO; browser blocks anyway.
      return new Response(null, { status: 204, headers: cors });
    }

    // --- GET /health (liveness only, no engine) ---
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "aeo-checker-worker" }, 200, cors);
    }

    // --- Layer 6: route + method gating ---
    const isScan = url.pathname === "/scan";
    const isScanSite = url.pathname === "/scan-site";
    if (!isScan && !isScanSite) {
      return json({ error: "not_found" }, 404, cors);
    }
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405, {
        ...cors,
        Allow: "POST, OPTIONS",
      });
    }

    // --- Layer 1: CORS origin gate (hard 403; Referer as secondary signal) ---
    if (!isOriginAllowed(origin, env)) {
      // Referer is only a secondary signal — never the sole gate — but a
      // present-and-allowed Referer with a missing Origin is still rejected
      // here because a browser fetch always sends Origin.
      return json({ error: "forbidden_origin" }, 403, cors);
    }
    const referer = request.headers.get("referer");
    if (referer) {
      try {
        const refOrigin = new URL(referer).origin;
        if (!isOriginAllowed(refOrigin, env)) {
          return json({ error: "forbidden_referer" }, 403, cors);
        }
      } catch {
        return json({ error: "forbidden_referer" }, 403, cors);
      }
    }

    if (isScanSite) {
      return handleScanSite(request, env, cors);
    }

    // --- Layer 6: parse + validate body ---
    let payload: { url?: unknown; turnstileToken?: unknown };
    try {
      payload = (await request.json()) as typeof payload;
    } catch {
      return json({ error: "invalid_json" }, 400, cors);
    }
    const targetUrl = payload.url;
    const token = payload.turnstileToken;

    if (typeof targetUrl !== "string" || targetUrl.length === 0) {
      return json({ error: "url_required" }, 400, cors);
    }
    if (targetUrl.length > MAX_URL_LEN) {
      return json({ error: "url_too_long", max: MAX_URL_LEN }, 400, cors);
    }
    let parsedTarget: URL;
    try {
      parsedTarget = new URL(targetUrl);
    } catch {
      return json({ error: "invalid_url" }, 400, cors);
    }
    if (parsedTarget.protocol !== "http:" && parsedTarget.protocol !== "https:") {
      return json({ error: "invalid_url_scheme" }, 400, cors);
    }
    if (typeof token !== "string" || token.length === 0) {
      return json({ error: "turnstile_required" }, 400, cors);
    }

    // --- Layer 5 (input-side): refuse to even scan an internal/SSRF target ---
    // The guarded fetch also re-checks every redirect hop, but rejecting here
    // gives an honest 400 instead of running the engine on a disallowed host.
    const ssrf = validateUrlForFetch(targetUrl);
    if (!ssrf.ok) {
      return json(
        {
          error: "blocked_target",
          detail: "This URL points to a disallowed (internal) address.",
        },
        400,
        cors,
      );
    }

    const ip = clientIp(request);

    // --- Layer 2: Turnstile (before any target fetch) ---
    const ts = await verifyTurnstile(token, env.TURNSTILE_SECRET, ip);
    if (!ts.ok) {
      return json(
        { error: "turnstile_failed", codes: ts.errorCodes },
        403,
        cors,
      );
    }

    // --- Layer 3: per-IP per-minute rate limit (native binding) ---
    try {
      const rl = await env.RATE_LIMITER.limit({ key: ip });
      if (!rl.success) {
        return json(
          { error: "rate_limited", detail: "Too many requests this minute. Please slow down." },
          429,
          { ...cors, "Retry-After": "60" },
        );
      }
    } catch {
      // If the binding is unavailable, fail closed on the minute limit is too
      // harsh; log-and-continue would be silent. We degrade to allow and rely
      // on the daily KV quota + global breaker below.
    }

    // --- Layers 4 & 7: per-IP daily quota + global circuit breaker (KV) ---
    const quota = await checkAndBumpQuotas(env, ip);
    if (!quota.allowed) {
      if (quota.blockedBy === "global") {
        return json(
          { error: "service_busy", detail: "The tool is busy right now. Please try again later." },
          503,
          { ...cors, "Retry-After": "3600" },
        );
      }
      return json(
        { error: "daily_limit", detail: "Daily scan limit reached for your IP. Try again tomorrow." },
        429,
        { ...cors, "Retry-After": "3600" },
      );
    }

    // --- Layer 5: run the engine through the SSRF-guarded fetch ---
    const guardedFetch = makeGuardedFetch(DEFAULT_GUARD);
    try {
      const report = await analyzeUrl(targetUrl, {
        fetchImpl: guardedFetch,
        timeoutMs: DEFAULT_GUARD.timeoutMs,
      });
      return json(report, 200, cors);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.startsWith("ssrf_blocked")) {
        return json(
          { error: "blocked_target", detail: "This URL points to a disallowed (internal) address." },
          400,
          cors,
        );
      }
      return json(
        { error: "scan_failed", detail: "Could not analyze the URL." },
        502,
        cors,
      );
    }
  },
};

/**
 * POST /scan-site — Fase 3, Step 2 (PLUMBING ONLY).
 *
 * Mirrors every /scan mitigation (CORS already gated by the caller, Turnstile,
 * SSRF input check, rate limit, daily quota / circuit breaker) but with two
 * WEIGHTED differences because a site-scan costs N single-page scans:
 *
 *   - Rate limit: a STRICTER per-IP per-minute limiter (SITE_RATE_LIMITER,
 *     2/60s) so it never collides with the /scan limiter.
 *   - Circuit breaker: WEIGHTED. N is only known after discovery+sampling, so:
 *       1. Pre-check the breaker (peekQuotas + canAbsorb with N=1) — if it is
 *          already tripped, 503 "busy" before any fetch.
 *       2. Run discovery+sampling+per-page scan via the core `siteScan`
 *          orchestrator, wrapped in a wall-clock timeout.
 *       3. Determine N = number of pages actually scanned (perPage.length), and
 *          bump both counters by N. If the remaining budget cannot absorb N we
 *          REFUSE with 503 "busy" rather than return a misleading partial —
 *          honesty over silently-trimmed results.
 *
 * Fase 3, Step 3: the orchestrator now returns the aggregated, honest site
 * score (30/70 split, mean + median + spread, coverage gap, hybrid per-page
 * AI-access reporting, estimate label) alongside the raw per-page output. This
 * handler passes that payload through unchanged — the gate/mitigation stack
 * above is untouched. No scoring math is applied here; it lives in the shared
 * core lib (src/site-scan/aggregate.ts).
 *
 * Response cache per origin is intentionally NOT implemented (kept as a TODO
 * below) to avoid weakening the weighted-breaker accounting; correctness of the
 * breaker is prioritized over a cache-hit optimization.
 */
async function handleScanSite(
  request: Request,
  env: Env,
  cors: Record<string, string>,
): Promise<Response> {
  // --- Layer 6: parse + validate body ---
  let payload: { url?: unknown; turnstileToken?: unknown };
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return json({ error: "invalid_json" }, 400, cors);
  }
  const targetUrl = payload.url;
  const token = payload.turnstileToken;

  if (typeof targetUrl !== "string" || targetUrl.length === 0) {
    return json({ error: "url_required" }, 400, cors);
  }
  if (targetUrl.length > MAX_URL_LEN) {
    return json({ error: "url_too_long", max: MAX_URL_LEN }, 400, cors);
  }
  let parsedTarget: URL;
  try {
    parsedTarget = new URL(targetUrl);
  } catch {
    return json({ error: "invalid_url" }, 400, cors);
  }
  if (parsedTarget.protocol !== "http:" && parsedTarget.protocol !== "https:") {
    return json({ error: "invalid_url_scheme" }, 400, cors);
  }
  if (typeof token !== "string" || token.length === 0) {
    return json({ error: "turnstile_required" }, 400, cors);
  }

  // Normalize to the ORIGIN — a site-scan is rooted at the origin, not a page.
  const origin = parsedTarget.origin;

  // --- Layer 5 (input-side): refuse an internal/SSRF target before anything. ---
  // The core lib re-validates every discovered URL, but reject here for an
  // honest 400 instead of running discovery on a disallowed host.
  const ssrf = validateUrlForFetch(origin);
  if (!ssrf.ok) {
    return json(
      {
        error: "blocked_target",
        detail: "This URL points to a disallowed (internal) address.",
      },
      400,
      cors,
    );
  }

  const ip = clientIp(request);

  // --- Layer 2: Turnstile (before any target fetch) ---
  const ts = await verifyTurnstile(token, env.TURNSTILE_SECRET, ip);
  if (!ts.ok) {
    return json({ error: "turnstile_failed", codes: ts.errorCodes }, 403, cors);
  }

  // --- Layer 3: STRICTER per-IP per-minute rate limit (site-scan binding) ---
  try {
    const rl = await env.SITE_RATE_LIMITER.limit({ key: ip });
    if (!rl.success) {
      return json(
        {
          error: "rate_limited",
          detail: "Too many site scans this minute. Please slow down.",
        },
        429,
        { ...cors, "Retry-After": "60" },
      );
    }
  } catch {
    // Binding unavailable: degrade to allow and rely on the daily weighted
    // breaker below (same posture as /scan).
  }

  // --- Layers 4 & 7 (pre-check): is the breaker already tripped? ---
  // We do not know N yet, so require budget for at least 1 unit before spending
  // any subrequests on discovery.
  const snapBefore = await peekQuotas(env, ip);
  const preCheck = canAbsorb(snapBefore, 1);
  if (!preCheck.allowed) {
    if (preCheck.blockedBy === "global") {
      return json(
        {
          error: "service_busy",
          detail: "The tool is busy right now. Please try again later.",
        },
        503,
        { ...cors, "Retry-After": "3600" },
      );
    }
    return json(
      {
        error: "daily_limit",
        detail: "Daily scan limit reached for your IP. Try again tomorrow.",
      },
      429,
      { ...cors, "Retry-After": "3600" },
    );
  }

  // --- Layer 5 + orchestrator: run siteScan through the SSRF-guarded fetch,
  //     wrapped in a whole-request wall-clock timeout. ---
  const guardedFetch = makeGuardedFetch(DEFAULT_GUARD);
  let scan;
  try {
    scan = await withTimeout(
      siteScan(origin, {
        fetchImpl: guardedFetch,
        timeoutMs: DEFAULT_GUARD.timeoutMs,
        concurrency: SITE_SCAN_CONCURRENCY,
      }),
      SITE_SCAN_TIMEOUT_MS,
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "site_scan_timeout") {
      return json(
        {
          error: "scan_timeout",
          detail:
            "The site scan took too long and was stopped. Please try a smaller site or retry later.",
        },
        504,
        cors,
      );
    }
    if (msg.startsWith("ssrf_blocked")) {
      return json(
        {
          error: "blocked_target",
          detail: "This URL points to a disallowed (internal) address.",
        },
        400,
        cors,
      );
    }
    return json(
      { error: "scan_failed", detail: "Could not analyze the site." },
      502,
      cors,
    );
  }

  // --- Layers 4 & 7 (weighted commit): N = pages actually scanned. ---
  const n = Math.max(1, scan.perPage.length);
  const absorb = canAbsorb(await peekQuotas(env, ip), n);
  if (!absorb.allowed) {
    // Not enough remaining budget for the full N. Refuse honestly rather than
    // return a partial/misleading result. Nothing is committed to the counters.
    return json(
      {
        error: "service_busy",
        detail:
          "The tool is busy right now. Please try again later.",
      },
      503,
      { ...cors, "Retry-After": "3600" },
    );
  }
  await bumpQuotasBy(env, ip, n);

  // Orchestrator output INCLUDING the aggregated site score (Fase 3, Step 3):
  // siteScore + answerReadinessBeta + blockDistribution + coverageGap +
  // worstPage + sampledPages, plus the raw per-page material. TODO(Fase 3):
  // optional per-origin response cache (key = origin + ":site") — deliberately
  // omitted to keep the weighted-breaker accounting exact.
  return json(scan, 200, cors);
}

/**
 * Race a promise against a wall-clock timeout. On timeout rejects with the
 * sentinel `site_scan_timeout` so the caller can return an honest 504. Note the
 * underlying work is not cancelled (the per-page guarded fetches carry their own
 * 9s aborts); this bounds the RESPONSE latency, not CPU.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("site_scan_timeout")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
