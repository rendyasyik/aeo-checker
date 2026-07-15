/**
 * aeo-checker REMOTE MCP server — Cloudflare Worker (PR2 of the remote-MCP plan).
 *
 * This is a SEPARATE deploy unit from the REST Worker (`worker/`, POST /scan).
 * It exposes the SAME two deterministic tools as the stdio-npm MCP
 * (aeo_scan_url, aeo_scan_site), but over a remote Streamable HTTP transport at
 * /mcp, gated by OAuth 2.1, so it can be registered as a claude.ai custom
 * connector.
 *
 * ARCHITECTURE (result of the PR2 research spike):
 *   - Transport + hosting: Cloudflare's `agents` package (`McpAgent`), whose
 *     `.serve("/mcp")` implements the OFFICIAL Streamable HTTP MCP transport on
 *     Workers, backed by a Durable Object (session state / stream resumability).
 *     The raw `@modelcontextprotocol/sdk` `StreamableHTTPServerTransport` is
 *     written against Node's `http` req/res and does NOT run unmodified on the
 *     Workers runtime; McpAgent is the Cloudflare-blessed path that actually
 *     works on Workers. This is a DELIBERATE deviation from the design note's
 *     "raw SDK transport, no DO" wording — see README "Deviations".
 *   - OAuth: `@cloudflare/workers-oauth-provider` wraps the whole Worker. It
 *     serves discovery (RFC 8414 + RFC 9728), DCR (RFC 7591 at /register),
 *     PKCE S256, the token endpoint, and stores grants/tokens in KV. Our
 *     `defaultHandler` (below) renders a MINIMAL consent screen and completes
 *     the authorization — no password / credential store, because this is a
 *     public read-only scanner; auth exists for connector eligibility,
 *     per-token attribution (PR3 rate limits) and a revocation path, not to
 *     protect private data. Token-farming is backstopped by the global cap
 *     (PR3).
 *   - Engine reuse: the two tools call the shared, runtime-agnostic MCP tool
 *     logic (`mcpScanUrl`/`mcpScanSite` from the core lib), injecting the
 *     Workers SSRF-guarded fetch. No engine or tool logic is duplicated here.
 */

import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  MAX_TOTAL_PAGES,
  mcpScanUrl,
  mcpScanSite,
  type McpToolResult,
  type McpToolRuntime,
} from "../../src/index.js";
import {
  makeGuardedFetch,
  DEFAULT_GUARD,
  SSRF_BLOCK_PREFIX,
} from "./guarded-fetch.js";
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { handleDefault } from "./auth-handler.js";

/** Fetch concurrency for per-page scans inside a site-scan. */
const SITE_SCAN_CONCURRENCY = 4;

/**
 * Props attached to each grant at authorization time and surfaced on every
 * authenticated tool call as `this.props`. `userId` is the per-token identity
 * used for attribution / per-token rate-limiting (PR3) and revocation.
 */
export interface AuthProps extends Record<string, unknown> {
  userId: string;
}

/** Bindings available to the Worker (see wrangler.toml). */
export interface Env {
  /** KV namespace the OAuth provider uses for grants/tokens/clients. */
  OAUTH_KV: KVNamespace;
  /** OAuth helpers injected by the provider wrapper. */
  OAUTH_PROVIDER: OAuthHelpers;
  /** Durable Object namespace backing the McpAgent (session state). */
  MCP_OBJECT: DurableObjectNamespace;
  /** Comma-separated extra allowed CORS origins (staging/preview). Optional. */
  ALLOWED_ORIGINS?: string;
}

/** Build the Workers ToolRuntime (SSRF-guarded fetch, no opt-out, no hint). */
function workerRuntime(): McpToolRuntime {
  return {
    fetchImpl: makeGuardedFetch(DEFAULT_GUARD),
    timeoutMs: DEFAULT_GUARD.timeoutMs,
    allowPrivateHosts: false,
    ssrf: { blockPrefix: SSRF_BLOCK_PREFIX },
  };
}

/** Turn a shared ToolResult into MCP content: a text summary + full JSON. */
function toMcpResult(r: McpToolResult) {
  return {
    content: [
      { type: "text" as const, text: r.text },
      {
        type: "text" as const,
        text: "```json\n" + JSON.stringify(r.structured, null, 2) + "\n```",
      },
    ],
    ...(r.isError ? { isError: true as const } : {}),
  };
}

/**
 * The remote MCP agent. `McpAgent` is a Durable Object; each authenticated
 * session gets an instance with the granted `props`. Tools are registered in
 * `init()`. The two tools mirror the stdio-npm server exactly (same names,
 * schemas, output), but there is NO `allowPrivateHosts` argument here: a public
 * remote surface must never scan internal hosts.
 */
export class AeoMcpAgent extends McpAgent<Env, unknown, AuthProps> {
  server = new McpServer({ name: "aeo-checker", version: "0.1.0" });

  async init(): Promise<void> {
    this.server.registerTool(
      "aeo_scan_url",
      {
        title: "Scan a single URL for AEO / AI-readiness",
        description:
          "Fetch one URL (raw HTML, no JS render) and score how ready it is to " +
          "be read and cited by AI crawlers, across six deterministic dimensions " +
          "(AI crawler access, content extractability without JS, structured " +
          "data, semantic structure, metadata/provenance, llms.txt). Returns the " +
          "full AeoReport as JSON plus a compact human summary. When " +
          "includeExtractedContent is true (default), it ALSO returns " +
          "extractedContent: the readable text an AI crawler actually sees plus " +
          "deterministic structural answer signals (FAQ schema, question " +
          "headings, answer paragraphs, TL;DR, step lists, HowTo schema). " +
          "IMPORTANT: this engine is deterministic and does NOT judge answer " +
          "quality; use extractedContent.mainText + answerStructure to judge " +
          "answer-ability yourself. Only public http/https URLs are scanned; " +
          "internal/private hosts are refused.",
        inputSchema: {
          url: z
            .string()
            .url()
            .describe("The absolute http/https URL to scan."),
          includeExtractedContent: z
            .boolean()
            .optional()
            .describe(
              "Attach extractedContent (mainText + answerStructure) for answer-ability judgement. Default true.",
            ),
        },
      },
      async (args) => {
        const r = await mcpScanUrl(
          {
            url: args.url,
            includeExtractedContent: args.includeExtractedContent,
          },
          workerRuntime(),
        );
        return toMcpResult(r);
      },
    );

    this.server.registerTool(
      "aeo_scan_site",
      {
        title: "Scan a site (sampled pages) for AEO / AI-readiness",
        description:
          "Discover a site (robots.txt / sitemap / nav fallback), " +
          "deterministically section-sample up to " +
          MAX_TOTAL_PAGES +
          " pages, scan each with the single-page engine, and return an HONEST " +
          "site-level aggregate: a 30/70 site-vs-page ESTIMATE score, per-page " +
          "mean/median/spread, block distribution, coverage gap (pages an AI " +
          "crawler could not access, excluded not scored 0), and a sampled-page " +
          "list. Returns the full SiteScanResult as JSON plus a compact summary. " +
          "NOTE: this returns STRUCTURAL AGGREGATES ONLY - it does NOT dump full " +
          "per-page extracted text (that would be enormous). To read a single " +
          "page's mainText + answerStructure, call aeo_scan_url on that URL. " +
          "Only public http/https sites are scanned; internal/private hosts are " +
          "refused.",
        inputSchema: {
          url: z
            .string()
            .url()
            .describe(
              "Any absolute http/https URL on the site; the scan is rooted at its origin.",
            ),
          maxPages: z
            .number()
            .int()
            .positive()
            .optional()
            .describe(
              "Upper bound on pages to report (clamped to the hard cap " +
                MAX_TOTAL_PAGES +
                "). Defaults to the hard cap.",
            ),
        },
      },
      async (args) => {
        const r = await mcpScanSite(
          {
            url: args.url,
            maxPages: args.maxPages,
            concurrency: SITE_SCAN_CONCURRENCY,
          },
          workerRuntime(),
        );
        return toMcpResult(r);
      },
    );
  }
}

/**
 * OAuth-wrapped Worker.
 *
 * - `/mcp` is the protected API route (Streamable HTTP transport). A valid
 *   access token is required; the granted props (userId) arrive as
 *   `this.props` inside the agent.
 * - Everything else (discovery, DCR, /authorize consent, /token, /health,
 *   /revoke) flows through `defaultHandler` OR is served by the provider itself
 *   (discovery + token + register).
 * - TTLs: access token 1h (accessTokenTTL), refresh token 30d (refreshTokenTTL),
 *   per the locked design.
 * - PKCE: `allowPlainPKCE: false` forces S256 only (OAuth 2.1).
 */
export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: AeoMcpAgent.serve("/mcp") as never,
  defaultHandler: { fetch: handleDefault } as never,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["aeo:scan"],
  accessTokenTTL: 60 * 60, // 1 hour
  refreshTokenTTL: 60 * 60 * 24 * 30, // 30 days
  allowImplicitFlow: false,
  allowPlainPKCE: false, // OAuth 2.1: S256 only
});
