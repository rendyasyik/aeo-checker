/**
 * Site-scan ORCHESTRATOR (Fase 3, Steps 1 + 3).
 *
 * Wires discovery -> section-aware sampling -> per-page single-page scan
 * (reusing the Fase 1 engine `analyzeUrl`), then aggregates the per-page +
 * site-level signals into one honest site score (Step 3).
 *
 * The aggregation methodology is the FINAL one validated by Alison
 * (fase-3-validasi-metodologi.md): a 30/70 site-vs-page split, per-page MEAN
 * with median + spread, HARD_BLOCK pages excluded as a coverage gap, hybrid
 * per-page AI-access reporting, and an estimate label. The math lives in
 * `./aggregate.ts` so the Worker and the MCP server share it. See
 * `aggregateSiteScore` below.
 */

import { analyzeUrl, type AnalyzeOptions } from "../index.js";
import type { AeoReport } from "../types.js";
import { validateUrlForFetch } from "../ssrf.js";
import { discover, type DiscoveryResult } from "./discovery.js";
import { sample, type SamplingResult, type SectionSample } from "./sampling.js";
import { aggregate, type SiteScoreResult } from "./aggregate.js";

/** One per-page scan result (or an honest error placeholder). */
export interface PageScanResult {
  url: string;
  /** The single-page AEO report, or null if the scan failed. */
  result: AeoReport | null;
  /** Error message if the per-page scan threw; null on success. */
  error: string | null;
}

export interface SiteScanOptions extends AnalyzeOptions {
  /**
   * Max concurrent per-page scans. The Worker wraps the whole call in a
   * wall-clock timeout; here we only bound parallelism, using nothing
   * Worker-specific. Default 4.
   */
  concurrency?: number;
}

export interface SiteScanResult {
  origin: string;
  /** Discovery metadata (source, robots/sitemap presence, counts). */
  discovery: DiscoveryResult;
  /** Per-section breakdown of what was sampled. */
  sections: SectionSample[];
  /** Sections dropped/partially-dropped by the cost cap. */
  sectionsTruncated: SamplingResult["truncatedSections"];
  /** Raw per-page scan results, one per sampled URL. */
  perPage: PageScanResult[];
  /** How many candidate/sample URLs were dropped by the SSRF guard. */
  droppedBySsrf: number;
  /** The site homepage URL (root), used as the site-level signal source. */
  homepage: string;
  /**
   * Aggregated, honest site-level score + spread + block distribution +
   * coverage gap + estimate label (Fase 3, Step 3). Null only in the degenerate
   * case where there were zero sampled pages to aggregate at all.
   */
  siteScore: SiteScoreResult["siteScore"] | null;
  /** Answer-readiness beta aggregated separately (mean across counted pages). */
  answerReadinessBeta: SiteScoreResult["answerReadinessBeta"] | null;
  /** Correction 1/2: honest per-URL distribution of what blocked what. */
  blockDistribution: SiteScoreResult["blockDistribution"] | null;
  /** Correction 2: pages an AI crawler could not access at all. */
  coverageGap: SiteScoreResult["coverageGap"] | null;
  /** Worst counted page (diagnostic only, no score weight). */
  worstPage: SiteScoreResult["worstPage"];
  /** Every sampled page with its section + score + block (correction 4). */
  sampledPages: SiteScoreResult["sampledPages"];
}

const DEFAULT_CONCURRENCY = 4;

/** Run tasks with a bounded concurrency pool, preserving input order in output. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));

  async function runWorker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i] as T;
      results[i] = await fn(item, i);
    }
  }

  const workers: Promise<void>[] = [];
  for (let w = 0; w < workerCount; w++) workers.push(runWorker());
  await Promise.all(workers);
  return results;
}

/**
 * Discover -> sample -> scan each sampled page (Fase 1 engine). Returns raw
 * per-page results + metadata. Does NOT compute a site-level score.
 */
export async function siteScan(
  origin: string,
  opts: SiteScanOptions = {},
): Promise<SiteScanResult> {
  const concurrency = opts.concurrency ?? DEFAULT_CONCURRENCY;

  // 1. Discovery (same-origin candidates, SSRF-filtered inside).
  const discovery = await discover(origin, opts);

  // 2. Deterministic section-aware sampling (cost-capped).
  const sampling: SamplingResult = sample(discovery.candidates, discovery.origin);

  // 3. Final SSRF pass on the exact URLs we are about to scan (defence in depth;
  //    discovery already filtered, but the sampled set must be re-validated).
  let droppedAtSample = 0;
  const toScan: string[] = [];
  for (const url of sampling.sampled) {
    if (validateUrlForFetch(url).ok) toScan.push(url);
    else droppedAtSample += 1;
  }

  // 4. Per-page single-page scan (reuse Fase 1 engine), bounded concurrency.
  const perPage = await mapWithConcurrency<string, PageScanResult>(
    toScan,
    concurrency,
    async (url) => {
      try {
        const result = await analyzeUrl(url, opts);
        return { url, result, error: null };
      } catch (e) {
        return {
          url,
          result: null,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    },
  );

  // 5. Aggregate per-page + site-level signals into one honest site score
  //    (Fase 3, Step 3). Shared math lives in ./aggregate.ts.
  const agg =
    perPage.length > 0 ? aggregate(perPage, sampling.homepage) : null;

  return {
    origin: discovery.origin,
    discovery,
    sections: sampling.sections,
    sectionsTruncated: sampling.truncatedSections,
    perPage,
    droppedBySsrf: discovery.droppedBySsrf + droppedAtSample,
    homepage: sampling.homepage,
    siteScore: agg?.siteScore ?? null,
    answerReadinessBeta: agg?.answerReadinessBeta ?? null,
    blockDistribution: agg?.blockDistribution ?? null,
    coverageGap: agg?.coverageGap ?? null,
    worstPage: agg?.worstPage ?? null,
    sampledPages: agg?.sampledPages ?? [],
  };
}

/**
 * Site-level score aggregation (Fase 3, Step 3 — FINAL, validated by Alison).
 *
 * Pure roll-up over an already-completed `SiteScanResult`: 30/70 site-vs-page
 * split, page-level MEAN + median + spread, HARD_BLOCK pages excluded as a
 * coverage gap (not scored 0), hybrid per-page AI-access reporting, and an
 * estimate label. Delegates to the shared `aggregate` in ./aggregate.ts so the
 * result is identical whether called here or precomputed inside `siteScan`.
 *
 * Returns the full aggregation payload. When there are zero sampled pages this
 * still returns a well-formed (empty-coverage) payload.
 */
export function aggregateSiteScore(scan: SiteScanResult): SiteScoreResult {
  return aggregate(scan.perPage, scan.homepage);
}
