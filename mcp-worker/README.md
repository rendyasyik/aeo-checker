# aeo-checker Remote MCP Worker

Remote **Model Context Protocol** server for the deterministic aeo-checker
engine, hosted on **Cloudflare Workers** and gated by **OAuth 2.1**, so it can be
registered as a **custom connector on claude.ai**.

It exposes the SAME two tools as the stdio-npm MCP server (`../mcp/`):

- `aeo_scan_url` — single-page AEO / AI-readiness scan (+ extracted content).
- `aeo_scan_site` — sampled site scan, structural aggregates only.

This is a **separate deploy unit** from the REST Worker (`../worker/`, `POST
/scan`). It reuses the shared, runtime-agnostic engine + MCP tool logic
(`../src/mcp-tools.ts`) and the shared SSRF-guarded fetch — nothing is
duplicated.

> **Status:** the claude.ai end-to-end handshake is **PENDING STAGING VERIFY**.
> It has NOT been tested against a live claude.ai connector yet; that requires a
> human-gated staging deploy (see "Deploy — staging" below). Build, typecheck
> and offline unit tests are green.

## Architecture (why these choices)

- **Transport + hosting: Cloudflare `agents` `McpAgent`.** `McpAgent.serve("/mcp")`
  implements the official **Streamable HTTP** MCP transport on Workers. The raw
  `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport` is written against
  Node's `http` req/res objects and does **not** run unmodified on the Workers
  runtime; `McpAgent` is the Cloudflare-blessed path that actually works on
  Workers.
- **Durable Object (deliberate deviation).** `McpAgent` is backed by a Durable
  Object (`MCP_OBJECT` / class `AeoMcpAgent`) for session state + stream
  resumability. The original design note said "no DO"; hosting Streamable-HTTP
  MCP on Workers with the supported library **requires** a DO. DO is included in
  **Workers Paid** at minimal cost. Bonus: it gives PR3 a strongly-consistent
  place for the global cap counter if we want one.
- **OAuth: `@cloudflare/workers-oauth-provider`.** Wraps the whole Worker; serves
  discovery, DCR, PKCE-S256 token flow, and stores grants/tokens in KV.

### Auth intent (read this before touching the consent screen)

These tools scan **public** URLs read-only. Auth is **not** protecting private
data. It exists to: (a) satisfy the claude.ai custom-connector requirement, (b)
attribute usage per-token for the PR3 rate limits, and (c) provide a revocation
path. So the consent screen is **minimal**: anyone who completes OAuth + PKCE
gets a token — there is **no password / credential store**. It is still a
correct OAuth 2.1 + PKCE-S256 + DCR flow. Token-farming is backstopped by the
**global daily cap** (PR3).

## OAuth endpoints (served automatically unless noted)

| Endpoint | RFC | Who serves it |
| --- | --- | --- |
| `/.well-known/oauth-authorization-server` | 8414 | oauth-provider (auto) |
| `/.well-known/oauth-protected-resource` | 9728 | oauth-provider (auto) |
| `/register` (DCR) | 7591 | oauth-provider (auto) |
| `/token` | 6749 / PKCE 7636 | oauth-provider (auto) |
| `/authorize` (minimal consent) | 6749 | our `defaultHandler` |
| `/revoke` (per-token kill-switch) | 7009 | our `defaultHandler` |
| `/health` | — | our `defaultHandler` |
| `/mcp` (Streamable HTTP, token-gated) | MCP | `McpAgent.serve` |

- **PKCE:** S256 enforced (`allowPlainPKCE: false`). Implicit flow disabled.
- **TTL:** access token **1 hour**, refresh token **30 days**.
- **KV:** binding `OAUTH_KV` holds grants/tokens/clients.
- **Revocation:** `POST /revoke` with a `token` (RFC 7009; always returns 200)
  unwraps the token → `revokeGrant(grantId, userId)`, killing that token/session.
  Mass revocation: rotate/purge the `OAUTH_KV` namespace (all tokens die, users
  re-authorize).

## One-time setup

From the repo root:

```bash
# 1. Create the OAuth KV namespace, then paste the returned id into
#    mcp-worker/wrangler.toml (replace PLACEHOLDER_REPLACE_WITH_OAUTH_KV_ID).
npx wrangler kv namespace create OAUTH_KV

# 2. (No app secrets are required.) The oauth-provider derives its signing
#    material from the grants stored in KV; there is no password/JWT secret to
#    set for the minimal-consent flow. If a future signing secret is added,
#    set it WITHOUT committing it:
#      npx wrangler secret put SOME_SECRET --config mcp-worker/wrangler.toml
#    Never hardcode or echo secrets.
```

## Deploy — staging (human-gated)

The default config in `wrangler.toml` targets **staging** on a `workers.dev`
subdomain (`name = aeo-mcp-staging`), with **no** custom domain, so a plain
deploy cannot touch production.

```bash
# from repo root, after the KV id is filled in:
npm run mcp-worker:deploy
# -> https://aeo-mcp-staging.<your-subdomain>.workers.dev
```

Local dev: `npm run mcp-worker:dev`.

## Deploy — production (opt-in only)

Only after the staging handshake is verified. Uncomment the `[env.production]`
block in `wrangler.toml` (custom domain `mcp.rendyandriyanto.com` + its own KV
id), then:

```bash
npx wrangler deploy --config mcp-worker/wrangler.toml --env production
```

DNS for `mcp.rendyandriyanto.com` is managed by Cloudflare via
`custom_domain = true` in that block.

## Register as a claude.ai custom connector

1. Deploy staging (above) and note the base URL, e.g.
   `https://aeo-mcp-staging.<subdomain>.workers.dev`.
2. In claude.ai → Settings → Connectors → Add custom connector, paste the base
   URL (the MCP endpoint is `<base>/mcp`). Claude discovers OAuth metadata at
   `<base>/.well-known/oauth-authorization-server`, self-registers via DCR, and
   runs the authorize → PKCE → token flow.
3. Approve the minimal consent screen; the two `aeo_*` tools appear.

## Verify (offline, no deploy)

```bash
npm run mcp-worker:typecheck   # tsc, no emit
npm test                       # includes mcp-worker/test/**
npx wrangler deploy --config mcp-worker/wrangler.toml --dry-run --outdir /tmp/x
```

## Deviations from the original design note

- **Durable Object used** (design said "no DO"): required by `McpAgent`, the
  supported Workers Streamable-HTTP MCP host. Cost: minimal, included in Workers
  Paid.
- **Staging-first wrangler config**: the design targets
  `mcp.rendyandriyanto.com`; this PR ships a staging-safe default and keeps
  production as an explicit, commented, opt-in `[env.production]` block so no
  accidental production deploy is possible from the default config.
