# aeo-checker Worker (Phase 2)

Cloudflare Worker that wraps the runtime-agnostic `aeo-checker` engine (Phase 1,
`../src`) behind a single JSON endpoint with seven layers of abuse mitigation.
JSON only — no HTML surface — so nothing here is indexable.

## Endpoints

| Method | Path      | Purpose |
|--------|-----------|---------|
| POST   | `/scan`   | `{ "url": string, "turnstileToken": string }` -> `AeoReport` JSON |
| OPTIONS| `/scan`   | CORS preflight (204) |
| GET    | `/health` | Liveness `{ ok: true }` |

Any other method/route -> 405 / 404.

## Seven mitigation layers (applied cheap -> costly)

1. **CORS locked** (`src/cors.ts`) — `Access-Control-Allow-Origin` is echoed
   ONLY for allowed origins, never `*`. Production default is
   `https://rendyandriyanto.com` + `https://www.rendyandriyanto.com`. Extra
   origins for dev/preview go in `ALLOWED_ORIGINS` (comma-separated). Disallowed
   Origin -> 403. Referer is checked as a secondary signal (never the sole gate).
2. **Turnstile invisible** (`src/turnstile.ts`) — `turnstileToken` is verified
   against `siteverify` BEFORE any target fetch. Fail -> 403. Secret from the
   `TURNSTILE_SECRET` Worker secret (never hardcoded).
3. **Per-IP per-minute rate limit** (`RATE_LIMITER` binding) — native Workers
   rate limiter, 10 requests / 60s keyed on `CF-Connecting-IP`. Over -> 429.
4. **Per-IP daily quota** (`src/counters.ts`, KV `COUNTERS`) — ~100 scans / IP /
   UTC day. Over -> 429.
5. **SSRF-guarded fetch** (`src/ssrf.ts` + `src/guarded-fetch.ts`) — injected
   into the engine as `fetchImpl`, so the page + robots.txt + llms.txt all go
   through it. http/https only; blocks private/loopback/link-local/metadata IPs
   (incl. 169.254.169.254); manual redirects with per-hop re-validation; 9s
   timeout; 3 MB body cap. The target URL is also pre-checked at the input layer
   (400 `blocked_target`) so we never run the engine on an internal host.
6. **Input hygiene** (`src/worker.ts`) — exactly one valid http/https URL,
   `<= 2048` chars; bad body -> 400; non-`POST /scan` -> 405/404.
7. **Global daily circuit breaker** (`src/counters.ts`, KV) — a global daily
   counter trips at `GLOBAL_DAILY_CAP` (800/day) and returns 503 "busy" instead
   of blowing the Cloudflare free tier.

## Config the operator must supply

| Name | Where | Notes |
|------|-------|-------|
| `TURNSTILE_SECRET` | Worker **secret** (`wrangler secret put`) | Production Turnstile secret key. NEVER commit. |
| `COUNTERS` KV id | `wrangler.toml` | Fill after `wrangler kv namespace create COUNTERS`. |
| `ALLOWED_ORIGINS` | `wrangler.toml [vars]` | Leave EMPTY in production. Dev/preview only. |
| Turnstile **sitekey** | frontend | Pairs with the secret. Invisible widget. |

### Cloudflare test keys (dev/preview only)

- always-passes secret: `1x0000000000000000000000000000000AA`
- always-fails secret: `2x0000000000000000000000000000000AA`
- invisible test sitekey (frontend): `1x00000000000000000000BB`

`.dev.vars` (gitignored) ships the always-passes secret for local `wrangler dev`.
Replace with the real secret in production via `wrangler secret put TURNSTILE_SECRET`.

## Deploy (authenticated account)

```bash
# 1. Authenticate wrangler once (interactive), or export CLOUDFLARE_API_TOKEN
#    with "Workers Scripts: Edit" + "Workers KV Storage: Edit" + account read.
wrangler login

# 2. Create the KV namespace, then paste the printed id into
#    worker/wrangler.toml -> [[kv_namespaces]] id = "..."
wrangler kv namespace create COUNTERS --config worker/wrangler.toml

# 3. Set the production Turnstile secret (prompted, never echoed).
wrangler secret put TURNSTILE_SECRET --config worker/wrangler.toml

# 4. Deploy. Omit any custom domain to get the *.workers.dev preview URL.
wrangler deploy --config worker/wrangler.toml
```

From the repo root the same steps are available as
`npm run worker:deploy` (and `npm run worker:dev` for local).

## KV free-tier write budget — caveat + design decision

KV free tier allows **1,000 writes/day** and has **no atomic increment**. Every
accepted scan bumps two counters (per-IP + global). The counter code
(`src/counters.ts`) does read -> enforce-on-read -> write-back, accepting
last-write-wins slack under concurrency (counts can undercount by a few). Two
things keep this safe:

- The **global circuit breaker cap (800/day)** trips well before the 1,000/day
  KV write ceiling AND far below Cloudflare's 100k/day request free ceiling, so
  the tool degrades to "busy" (503) rather than jeopardizing the free tier.
- Per-IP + global caps are set conservatively low relative to the true ceiling;
  for an anti-abuse guard, slightly under-serving at the extreme edge is the
  right direction to be wrong in.

If scan volume ever justifies it, the cheaper alternatives are: increment only
when approaching a threshold, or move hot counters to the Cache API / Durable
Objects. Not needed at current (low) expected volume.
