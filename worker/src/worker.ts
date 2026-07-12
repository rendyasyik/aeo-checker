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
 */

import { analyzeUrl } from "../../src/index.js";
import { makeGuardedFetch, DEFAULT_GUARD } from "./guarded-fetch.js";
import { verifyTurnstile } from "./turnstile.js";
import { corsHeaders, isOriginAllowed } from "./cors.js";
import { checkAndBumpQuotas, type CounterEnv } from "./counters.js";
import { validateUrlForFetch } from "./ssrf.js";

export interface Env extends CounterEnv {
  /** Turnstile secret key (Worker secret; NEVER hardcoded). */
  TURNSTILE_SECRET: string;
  /** Comma-separated extra allowed origins (dev/preview). Optional. */
  ALLOWED_ORIGINS?: string;
  /** Native per-IP per-minute rate limiter binding. */
  RATE_LIMITER: { limit: (o: { key: string }) => Promise<{ success: boolean }> };
}

const MAX_URL_LEN = 2048;

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
    if (url.pathname !== "/scan") {
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
      // here because a browser fetch to /scan always sends Origin.
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
