/**
 * Default (non-API) request handler for the remote MCP Worker.
 *
 * The `@cloudflare/workers-oauth-provider` wrapper itself serves the OAuth
 * machinery: discovery (/.well-known/oauth-authorization-server RFC 8414 +
 * /.well-known/oauth-protected-resource RFC 9728), dynamic client registration
 * (/register RFC 7591), and the token endpoint (/token). Everything ELSE routes
 * here. This handler implements:
 *
 *   - GET  /authorize  -> a MINIMAL consent screen. No password / credential
 *                         store: this is a PUBLIC read-only URL scanner, so auth
 *                         exists for (a) claude.ai connector eligibility, (b)
 *                         per-token attribution for PR3 rate limits, (c) a
 *                         revocation path — NOT to protect private data. Anyone
 *                         who completes OAuth+PKCE gets a token; token-farming is
 *                         backstopped by the global cap (PR3).
 *   - POST /authorize  -> the user pressed "Authorize"; mint a fresh anonymous
 *                         userId, complete the grant (PKCE verified by the
 *                         provider), and 302 back to the client with the code.
 *   - GET  /health     -> liveness (no engine, no auth).
 *   - POST /revoke     -> RFC 7009 token revocation: the provider does not expose
 *                         a /revoke endpoint automatically, so we implement it
 *                         via OAuthHelpers (unwrapToken -> revokeGrant), giving a
 *                         per-token kill-switch. Idempotent + always 200 per RFC.
 *
 * The consent HTML is intentionally tiny and self-contained (no external assets)
 * so there is no third-party surface to index or attack.
 */

import type {
  OAuthHelpers,
  AuthRequest,
} from "@cloudflare/workers-oauth-provider";
import { corsHeaders, type CorsEnv } from "./cors.js";

interface DefaultEnv extends CorsEnv {
  OAUTH_PROVIDER: OAuthHelpers;
}

/**
 * Generate an anonymous per-grant user id. There is no login, so each authorize
 * mints a distinct opaque id; it becomes the attribution key (`props.userId`)
 * carried on every tool call and the handle used for per-token revocation.
 */
export function newAnonymousUserId(): string {
  // crypto.randomUUID is available in the Workers runtime.
  return `anon_${crypto.randomUUID()}`;
}

/**
 * Build the minimal consent page HTML. Pure + testable. Shows the requesting
 * client id + scopes and a single Authorize button that POSTs back the opaque
 * request payload the provider gave us.
 */
export function consentPageHtml(opts: {
  clientName: string;
  scopes: string[];
  encodedRequest: string;
}): string {
  const scopeList =
    opts.scopes.length > 0
      ? opts.scopes.map((s) => escapeHtml(s)).join(", ")
      : "aeo:scan";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Authorize aeo-checker</title>
<style>
  body{font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#111}
  .card{border:1px solid #e2e2e2;border-radius:12px;padding:1.5rem}
  h1{font-size:1.25rem;margin:0 0 .5rem}
  .muted{color:#555;font-size:.95rem}
  code{background:#f4f4f4;padding:.1rem .35rem;border-radius:4px}
  button{margin-top:1rem;font:inherit;padding:.6rem 1.2rem;border:0;border-radius:8px;background:#111;color:#fff;cursor:pointer}
</style></head>
<body><div class="card">
<h1>Authorize AEO Checker</h1>
<p class="muted"><strong>${escapeHtml(opts.clientName)}</strong> is requesting access to the
AEO Checker tools (<code>${scopeList}</code>).</p>
<p class="muted">These tools scan <em>public</em> web pages for AI-readiness. No
personal data or private account is involved. Authorizing issues an access token
so the connector can call the scan tools; you can revoke it at any time.</p>
<form method="POST" action="/authorize">
<input type="hidden" name="oauthReq" value="${escapeHtml(opts.encodedRequest)}">
<button type="submit">Authorize</button>
</form>
</div></body></html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-robots-tag": "noindex, nofollow",
      "cache-control": "no-store",
    },
  });
}

function json(
  body: unknown,
  status: number,
  extra: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
  });
}

/**
 * The default handler entry point. Signature matches an ExportedHandler.fetch.
 */
export async function handleDefault(
  request: Request,
  env: DefaultEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  const cors = corsHeaders(origin, env);

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  // --- GET /health (liveness only) ---
  if (request.method === "GET" && url.pathname === "/health") {
    return json({ ok: true, service: "aeo-checker-mcp-worker" }, 200, cors);
  }

  // --- /authorize (minimal consent) ---
  if (url.pathname === "/authorize") {
    if (request.method === "GET") {
      return handleAuthorizeGet(request, env);
    }
    if (request.method === "POST") {
      return handleAuthorizePost(request, env);
    }
    return json({ error: "method_not_allowed" }, 405, { Allow: "GET, POST" });
  }

  // --- POST /revoke (RFC 7009 token revocation / per-token kill-switch) ---
  if (url.pathname === "/revoke") {
    if (request.method !== "POST") {
      return json({ error: "method_not_allowed" }, 405, {
        ...cors,
        Allow: "POST",
      });
    }
    return handleRevoke(request, env, cors);
  }

  return json({ error: "not_found" }, 404, cors);
}

/**
 * GET /authorize: parse the OAuth request via the provider, then render the
 * minimal consent screen. We round-trip the parsed request to the POST handler
 * as base64url JSON in a hidden field, so the second leg has the exact same
 * AuthRequest without re-parsing query params the provider already consumed.
 */
async function handleAuthorizeGet(
  request: Request,
  env: DefaultEnv,
): Promise<Response> {
  let authReq: AuthRequest;
  try {
    authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch {
    return html(
      consentErrorHtml("This authorization request is invalid or malformed."),
      400,
    );
  }

  let clientName = authReq.clientId;
  try {
    const client = await env.OAUTH_PROVIDER.lookupClient(authReq.clientId);
    if (client?.clientName) clientName = client.clientName;
  } catch {
    // fall back to the raw client id
  }

  const encoded = encodeAuthRequest(authReq);
  return html(
    consentPageHtml({
      clientName,
      scopes: authReq.scope,
      encodedRequest: encoded,
    }),
  );
}

/**
 * POST /authorize: the user approved. Recover the AuthRequest, mint an
 * anonymous userId, and complete the grant. The provider verifies PKCE and
 * returns the redirect (with the authorization code) to send the client to.
 */
async function handleAuthorizePost(
  request: Request,
  env: DefaultEnv,
): Promise<Response> {
  const form = await request.formData();
  const encoded = form.get("oauthReq");
  if (typeof encoded !== "string") {
    return html(consentErrorHtml("Missing authorization payload."), 400);
  }
  let authReq: AuthRequest;
  try {
    authReq = decodeAuthRequest(encoded);
  } catch {
    return html(consentErrorHtml("Corrupt authorization payload."), 400);
  }

  const userId = newAnonymousUserId();
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: authReq,
    userId,
    scope: authReq.scope,
    metadata: { anonymous: true },
    props: { userId },
  });

  return new Response(null, {
    status: 302,
    headers: { Location: redirectTo, "cache-control": "no-store" },
  });
}

/**
 * POST /revoke (RFC 7009). Accepts `token` in a form body. We unwrap the token
 * to find its grant, then revoke the grant (kill-switch for that token/session).
 * Per RFC 7009 the endpoint returns 200 even for an unknown/already-revoked
 * token, so it never leaks token validity.
 */
async function handleRevoke(
  request: Request,
  env: DefaultEnv,
  cors: Record<string, string>,
): Promise<Response> {
  let token: string | null = null;
  const ct = request.headers.get("content-type") ?? "";
  try {
    if (ct.includes("application/json")) {
      const body = (await request.json()) as { token?: unknown };
      if (typeof body.token === "string") token = body.token;
    } else {
      const form = await request.formData();
      const t = form.get("token");
      if (typeof t === "string") token = t;
    }
  } catch {
    // ignore parse errors; RFC 7009 still wants a 200
  }

  if (token) {
    try {
      // TokenSummary carries grantId + userId directly; revokeGrant needs both
      // and cascades to the token(s) under that grant (per-token kill-switch).
      const info = await env.OAUTH_PROVIDER.unwrapToken(token);
      if (info?.grantId && info.userId) {
        await env.OAUTH_PROVIDER.revokeGrant(info.grantId, info.userId);
      }
    } catch {
      // Swallow: revocation is best-effort + idempotent per RFC 7009.
    }
  }

  return json({ ok: true }, 200, cors);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** base64url-encode the parsed AuthRequest for the consent round-trip. */
export function encodeAuthRequest(req: AuthRequest): string {
  const bytes = enc.encode(JSON.stringify(req));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode the base64url AuthRequest produced by encodeAuthRequest. */
export function decodeAuthRequest(encoded: string): AuthRequest {
  const b64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(dec.decode(bytes)) as AuthRequest;
}

function consentErrorHtml(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="robots" content="noindex, nofollow"><title>Authorization error</title></head>
<body style="font:16px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem">
<h1 style="font-size:1.2rem">Authorization error</h1>
<p>${escapeHtml(message)}</p></body></html>`;
}
