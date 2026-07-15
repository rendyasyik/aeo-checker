/**
 * Shared, RUNTIME-AGNOSTIC MCP tool logic for the two aeo-checker MCP wrappers:
 *   - the stdio-npm server (`mcp/`, runs on Node), and
 *   - the remote MCP Worker (`mcp-worker/`, runs on Cloudflare Workers).
 *
 * BEFORE this module the tool bodies (SSRF pre-check, engine invocation, the
 * page-cap re-aggregation, and the human-readable summary formatting) lived
 * ONLY in `mcp/src/tools.ts`. Hosting the same two tools remotely would have
 * meant copy-pasting all of that into the Worker, which drifts. So the tool
 * LOGIC now lives HERE and both wrappers delegate to it, injecting only their
 * runtime-specific bits:
 *
 *   - `fetchImpl`  the SSRF-guarded fetch for that runtime (Node guarded-fetch
 *                  with a DNS resolver, or the Workers guarded-fetch with `cf:`
 *                  cache-bypass and no resolver). The engine + every subrequest
 *                  flows through it.
 *   - `timeoutMs`  the per-request wall-clock budget for that runtime.
 *   - error text   each wrapper passes its own SSRF block prefix + hint so the
 *                  honest error message stays runtime-appropriate (the Node MCP
 *                  appends the AEO_ALLOW_PRIVATE_HOSTS=1 hint; the Worker does
 *                  not).
 *
 * This file imports ONLY from the runtime-agnostic engine (`./index.js`), so it
 * compiles and runs unchanged on Node and Workers. It contains NO transport,
 * NO guarded-fetch construction, and NO engine logic (it merely CALLS the
 * engine) — the deterministic scan/scoring is never re-implemented here.
 *
 * Both tools return a { text, structured } pair: `text` is a compact
 * human-readable summary for the host LLM to read at a glance, and `structured`
 * is the full machine-readable payload (AeoReport / SiteScanResult). Each
 * wrapper's transport turns these into MCP content blocks.
 */

import {
  analyzeUrl,
  type AeoReport,
  siteScan,
  type SiteScanResult,
  MAX_TOTAL_PAGES,
  aggregate,
  type SiteScoreResult,
  validateUrlForFetch,
} from "./index.js";

// ---------------------------------------------------------------------------
// result shape + honest error mapping
// ---------------------------------------------------------------------------

export interface ToolResult {
  /** Compact human-readable summary. */
  text: string;
  /** Full structured payload (JSON-serializable). */
  structured: unknown;
  /** true when the tool failed (SSRF block, fetch error). */
  isError?: boolean;
}

/**
 * Runtime-specific SSRF error text. Each wrapper supplies its own prefix (the
 * shared guarded-fetch throws `${blockPrefix}:reason`) and an optional hint that
 * is appended to the human-facing message (Node MCP: the opt-in env-var hint;
 * Worker: none, since a public surface never opts out).
 */
export interface SsrfMessaging {
  /** Error-message prefix the guarded fetch uses for a blocked ENTRY url. */
  blockPrefix: string;
  /** Optional hint appended to the human-facing SSRF error text. */
  hint?: string;
}

/**
 * Common shape both wrappers pass in: the SSRF-guarded fetch for the runtime,
 * the per-request timeout, whether the caller opted in to private hosts, the
 * SSRF error messaging, and (Node only) a flag saying an injected TEST fetch is
 * in use so the input-side SSRF pre-check is skipped.
 */
export interface ToolRuntime {
  /** SSRF-guarded fetch injected into the engine as fetchImpl. */
  fetchImpl: typeof fetch;
  /** Per-request wall-clock timeout in ms (passed to the engine). */
  timeoutMs: number;
  /** Whether the developer opted in to private/internal hosts. */
  allowPrivateHosts: boolean;
  /** Runtime-specific SSRF error prefix + hint. */
  ssrf: SsrfMessaging;
  /**
   * When true the input-side SSRF pre-check is skipped (a test injected a fetch
   * that bypasses the network + guard). Defaults to false.
   */
  bypassInputSsrfCheck?: boolean;
}

function ssrfBlockResult(text: string): ToolResult {
  return {
    isError: true,
    text,
    structured: { error: "blocked_host", detail: text },
  };
}

/**
 * Input-side SSRF pre-check. The core `fetchRaw` SWALLOWS fetch exceptions
 * (returns an error FetchResult instead of throwing), so relying on the guarded
 * fetch to throw is not enough to give an honest tool error. Reject an
 * internal/SSRF target up front unless the developer opted in. Returns a
 * ToolResult on block, or null to proceed.
 */
function ssrfPreCheck(url: string, rt: ToolRuntime): ToolResult | null {
  if (rt.allowPrivateHosts) return null;
  const check = validateUrlForFetch(url);
  if (check.ok) return null;
  const base = `${rt.ssrf.blockPrefix}:${check.reason}`;
  const text = rt.ssrf.hint ? `${base}: ${rt.ssrf.hint}` : base;
  return ssrfBlockResult(text);
}

function ssrfOrErrorResult(e: unknown, rt: ToolRuntime): ToolResult {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.startsWith(rt.ssrf.blockPrefix)) {
    const text =
      rt.ssrf.hint && !msg.includes(rt.ssrf.hint)
        ? `${msg}: ${rt.ssrf.hint}`
        : msg;
    return ssrfBlockResult(text);
  }
  return {
    isError: true,
    text: `Scan failed: ${msg}`,
    structured: { error: "scan_failed", detail: msg },
  };
}

/** Shared guidance appended to aeo_scan_url output for the host LLM. */
const ANSWER_ABILITY_GUIDANCE =
  "GUIDANCE: This engine is DETERMINISTIC and does NOT judge answer quality. " +
  "The 0-100 score measures AI-readiness plumbing (crawler access, extractability, " +
  "schema, structure, metadata, llms.txt) only. To judge ANSWER-ABILITY (does this " +
  "page actually answer the user's question well?), read extractedContent.mainText " +
  "together with extractedContent.answerStructure and form your own judgement. That " +
  "qualitative judgement is YOUR job as the host LLM; it is the whole point of this " +
  "MCP surface versus the deterministic web tool.";

// ---------------------------------------------------------------------------
// aeo_scan_url
// ---------------------------------------------------------------------------

export interface ScanUrlArgs {
  url: string;
  includeExtractedContent?: boolean;
}

export async function scanUrl(
  args: ScanUrlArgs,
  rt: ToolRuntime,
): Promise<ToolResult> {
  const includeExtractedContent = args.includeExtractedContent ?? true;

  if (!rt.bypassInputSsrfCheck) {
    const blocked = ssrfPreCheck(args.url, rt);
    if (blocked) return blocked;
  }

  let report: AeoReport;
  try {
    report = await analyzeUrl(args.url, {
      includeExtractedContent,
      fetchImpl: rt.fetchImpl,
      timeoutMs: rt.timeoutMs,
    });
  } catch (e) {
    return ssrfOrErrorResult(e, rt);
  }

  return { text: formatUrlSummary(report), structured: report };
}

function formatUrlSummary(r: AeoReport): string {
  const lines: string[] = [];
  lines.push(`AEO scan: ${r.finalUrl}`);
  lines.push(`Score: ${r.total}/100 (grade ${r.grade})`);
  lines.push(
    `Block status: ${r.block.status}${
      r.block.status === "OK" ? "" : ` (${r.block.reason})`
    }`,
  );
  lines.push(
    `Answer-readiness (beta, structural proxy, NOT quality): ${r.answerReadinessBeta.score}/100 (grade ${r.answerReadinessBeta.grade})`,
  );

  const dims = Object.values(r.dimensions)
    .map((d) => `  - ${d.label}: ${d.score}/${d.max}`)
    .join("\n");
  lines.push("Dimensions:");
  lines.push(dims);

  const topFixes = r.fixes.slice(0, 5);
  if (topFixes.length > 0) {
    lines.push("Top fixes (impact-first):");
    for (const f of topFixes) {
      lines.push(`  - [${f.severity}] ${f.message} (~+${f.impact})`);
    }
  } else {
    lines.push("Top fixes: none (page is already well-optimized).");
  }

  if (r.extractedContent) {
    const ec = r.extractedContent;
    const as = ec.answerStructure;
    lines.push(
      `Extracted content: ${ec.wordCount} words${
        ec.truncated
          ? ` (mainText truncated to cap; originalLength=${ec.originalLength})`
          : ""
      }${ec.blocked ? " [BLOCKED: text reflects only raw HTML]" : ""}`,
    );
    lines.push(
      `Answer structure: faqSchema=${as.faqSchema} faqBlock=${as.faqBlock} ` +
        `questionHeadings=${as.questionHeadingCount} answerParagraphs=${as.answerParagraphCount} ` +
        `tldr=${as.tldr} orderedLists=${as.orderedListCount} howToSchema=${as.howToSchema}`,
    );
  }

  lines.push("");
  lines.push(ANSWER_ABILITY_GUIDANCE);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// aeo_scan_site
// ---------------------------------------------------------------------------

export interface ScanSiteArgs {
  url: string;
  maxPages?: number;
  /** Bound concurrency (defaults to core default). */
  concurrency?: number;
}

export async function scanSite(
  args: ScanSiteArgs,
  rt: ToolRuntime,
): Promise<ToolResult> {
  // Input-side SSRF gate on the ORIGIN (a site-scan is rooted at the origin).
  if (!rt.bypassInputSsrfCheck) {
    let origin = args.url;
    try {
      origin = new URL(args.url).origin;
    } catch {
      // fall through; validateUrlForFetch will report invalid_url
    }
    const blocked = ssrfPreCheck(origin, rt);
    if (blocked) return blocked;
  }

  // Effective page cap: respect the hard core constant MAX_TOTAL_PAGES.
  const requested = args.maxPages ?? MAX_TOTAL_PAGES;
  const cap = Math.max(1, Math.min(MAX_TOTAL_PAGES, Math.floor(requested)));

  let scan: SiteScanResult;
  try {
    scan = await siteScan(args.url, {
      fetchImpl: rt.fetchImpl,
      timeoutMs: rt.timeoutMs,
      concurrency: args.concurrency,
    });
  } catch (e) {
    return ssrfOrErrorResult(e, rt);
  }

  const effective = applyPageCap(scan, cap);
  return { text: formatSiteSummary(effective, cap), structured: effective };
}

/**
 * Trim the per-page results to the first `cap` pages (deterministic order:
 * homepage first, then by section, as produced by the core sampler) and
 * re-aggregate so the site score reflects exactly the reported pages. When the
 * scan already has <= cap pages this is a no-op passthrough.
 */
function applyPageCap(scan: SiteScanResult, cap: number): SiteScanResult {
  if (scan.perPage.length <= cap) return scan;
  const perPage = scan.perPage.slice(0, cap);
  const agg: SiteScoreResult | null =
    perPage.length > 0 ? aggregate(perPage, scan.homepage) : null;
  return {
    ...scan,
    perPage,
    siteScore: agg?.siteScore ?? null,
    answerReadinessBeta: agg?.answerReadinessBeta ?? null,
    blockDistribution: agg?.blockDistribution ?? null,
    coverageGap: agg?.coverageGap ?? null,
    worstPage: agg?.worstPage ?? null,
    sampledPages: agg?.sampledPages ?? [],
  };
}

function formatSiteSummary(s: SiteScanResult, cap: number): string {
  const lines: string[] = [];
  lines.push(`AEO site scan: ${s.origin}`);
  lines.push(
    `Pages scanned: ${s.perPage.length} (cap ${cap}, hard max ${MAX_TOTAL_PAGES}); discovery source: ${s.discovery.source}`,
  );

  if (s.siteScore && s.siteScore.total !== null) {
    const ss = s.siteScore;
    lines.push(
      `Site score (ESTIMATE from ${ss.pageLevel.countedPages} counted pages): ${ss.total}/100 (grade ${ss.grade})`,
    );
    lines.push(
      `Per-page (0-70 portion) spread: mean=${ss.pageLevel.mean} median=${ss.pageLevel.median} ` +
        `stdev=${ss.pageLevel.stdev} min=${ss.pageLevel.min} max=${ss.pageLevel.max}`,
    );
    lines.push(
      `Site-level (0-30 portion, judged once from ${ss.siteLevel.source ?? "root"}): ` +
        `aiCrawlerAccess=${ss.siteLevel.aiCrawlerAccess}/22 llmsTxt=${ss.siteLevel.llmsTxt}/8`,
    );
  } else {
    lines.push(
      `Site score: n/a${
        s.siteScore?.unscorableReason
          ? ` (${s.siteScore.unscorableReason})`
          : " (no pages could be aggregated)"
      }.`,
    );
  }

  if (s.answerReadinessBeta) {
    lines.push(
      `Answer-readiness (beta, structural, NOT quality): mean ${s.answerReadinessBeta.mean}/100 over ${s.answerReadinessBeta.countedPages} pages`,
    );
  }

  if (s.coverageGap) {
    lines.push(
      `Coverage gap: ${s.coverageGap.inaccessible} of ${s.coverageGap.total} sampled pages an AI crawler could NOT access (excluded from score, not scored 0).`,
    );
  }

  if (s.blockDistribution) {
    const bd = s.blockDistribution;
    lines.push(
      `Block distribution: HARD_BLOCK=${bd.hardBlock.length} SOFT_BLOCK=${bd.softBlock.length} ` +
        `robotsDisallowed=${bd.robotsDisallowed.length} metaNoindex=${bd.metaNoindex.length}`,
    );
  }

  if (s.worstPage) {
    lines.push(`Worst counted page: ${s.worstPage.url} (${s.worstPage.total}/100)`);
  }

  lines.push("");
  lines.push(
    "NOTE: Site scan reports STRUCTURAL AGGREGATES only. Full per-page extracted text is " +
      "NOT dumped here (context-budget + it would be enormous). For a single page's mainText + " +
      "answerStructure, call aeo_scan_url on that URL. Answer-ability across the site is your " +
      "(host LLM) judgement over these structural signals; the engine does not judge quality.",
  );
  return lines.join("\n");
}
