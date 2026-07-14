/**
 * Node MCP tool adapters — a THIN wrapper over the shared, runtime-agnostic MCP
 * tool logic (`src/mcp-tools.ts`, compiled to `../../dist/mcp-tools.js`).
 *
 * The tool BODIES (SSRF pre-check, engine invocation, page-cap re-aggregation,
 * and the human-readable summary formatting) now live in the shared core so the
 * stdio-npm server here and the remote MCP Worker (`mcp-worker/`) cannot drift.
 * This file keeps only the NODE-specific policy:
 *
 *   - resolve `allowPrivateHosts` from the per-call flag / AEO_ALLOW_PRIVATE_HOSTS
 *     env (secure by default);
 *   - build the Node SSRF-guarded fetch (with a DNS resolver for the
 *     DNS-rebinding defence the Worker cannot do);
 *   - carry the Node-specific SSRF hint text (the AEO_ALLOW_PRIVATE_HOSTS=1 hint);
 *   - keep the SAME public function signatures the stdio transport + the existing
 *     unit tests use (`scanUrl`/`scanSite` accepting an injectable `fetchImpl`).
 */

import {
  mcpScanUrl,
  mcpScanSite,
  type McpToolResult,
  type McpToolRuntime,
} from "../../dist/index.js";
import {
  makeNodeGuardedFetch,
  resolveAllowPrivateHosts,
  DEFAULT_GUARD,
  SSRF_BLOCK_PREFIX,
  SSRF_HINT,
} from "./guarded-fetch.js";

/** Re-export the shared result shape under the historical local name. */
export type ToolResult = McpToolResult;

/** Build the Node ToolRuntime for a resolved allowPrivateHosts + fetch. */
function nodeRuntime(
  allowPrivateHosts: boolean,
  fetchImpl: typeof fetch,
  bypassInputSsrfCheck: boolean,
): McpToolRuntime {
  return {
    fetchImpl,
    timeoutMs: DEFAULT_GUARD.timeoutMs,
    allowPrivateHosts,
    ssrf: { blockPrefix: SSRF_BLOCK_PREFIX, hint: SSRF_HINT },
    bypassInputSsrfCheck,
  };
}

// ---------------------------------------------------------------------------
// aeo_scan_url
// ---------------------------------------------------------------------------

export interface ScanUrlArgs {
  url: string;
  includeExtractedContent?: boolean;
  allowPrivateHosts?: boolean;
  /** Injectable fetch for tests (bypasses the network + guard). */
  fetchImpl?: typeof fetch;
}

export async function scanUrl(args: ScanUrlArgs): Promise<ToolResult> {
  const allowPrivateHosts = resolveAllowPrivateHosts(args.allowPrivateHosts);
  const fetchImpl =
    args.fetchImpl ??
    makeNodeGuardedFetch({ ...DEFAULT_GUARD, allowPrivateHosts });
  const rt = nodeRuntime(allowPrivateHosts, fetchImpl, Boolean(args.fetchImpl));
  return mcpScanUrl(
    {
      url: args.url,
      includeExtractedContent: args.includeExtractedContent,
    },
    rt,
  );
}

// ---------------------------------------------------------------------------
// aeo_scan_site
// ---------------------------------------------------------------------------

export interface ScanSiteArgs {
  url: string;
  maxPages?: number;
  allowPrivateHosts?: boolean;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Bound concurrency (defaults to core default). */
  concurrency?: number;
}

export async function scanSite(args: ScanSiteArgs): Promise<ToolResult> {
  const allowPrivateHosts = resolveAllowPrivateHosts(args.allowPrivateHosts);
  const fetchImpl =
    args.fetchImpl ??
    makeNodeGuardedFetch({ ...DEFAULT_GUARD, allowPrivateHosts });
  const rt = nodeRuntime(allowPrivateHosts, fetchImpl, Boolean(args.fetchImpl));
  return mcpScanSite(
    {
      url: args.url,
      maxPages: args.maxPages,
      concurrency: args.concurrency,
    },
    rt,
  );
}
