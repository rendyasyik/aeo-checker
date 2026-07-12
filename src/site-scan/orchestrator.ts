/**
 * Site-scan ORCHESTRATOR (Fase 3, Step 1).
 *
 * Wires discovery -> section-aware sampling -> per-page single-page scan
 * (reusing the Fase 1 engine `analyzeUrl`), and returns the RAW per-page
 * results plus discovery/sampling metadata.
 *
 * SCOPE FENCE (hard): this deliberately STOPS BEFORE site-level score
 * aggregation. The methodology for rolling per-page + site-level signals into a
 * single site grade (e.g. a 30/70 site-vs-page split, per-page averaging, and a
 * worst-page rollup) is still being validated by Alison and is NOT implemented
 * here. See `aggregateSiteScore` below — it is an intentional stub.
 */

import { analyzeUrl, type AnalyzeOptions } from "../index.js";
import type { AeoReport } from "../types.js";
import { validateUrlForFetch } from "../ssrf.js";
import { discover, type DiscoveryResult } from "./discovery.js";
import { sample, type SamplingResult, type SectionSample } from "./sampling.js";

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
  /**
   * Placeholder for the site-level aggregated score. Intentionally left null
   * until Alison validates the aggregation methodology (see aggregateSiteScore).
   */
  siteScore: null;
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

  return {
    origin: discovery.origin,
    discovery,
    sections: sampling.sections,
    sectionsTruncated: sampling.truncatedSections,
    perPage,
    droppedBySsrf: discovery.droppedBySsrf + droppedAtSample,
    siteScore: null,
  };
}

/**
 * Site-level score aggregation.
 *
 * TODO(Fase 3, pending Alison validation): site-level vs page-level split +
 * aggregation. The approved-but-unvalidated design is a 30/70 split (site-level
 * signals 30 + averaged page-level 70) combined with a worst-page rollup. That
 * methodology is NOT implemented yet. For now this returns the raw material
 * only ({ perPage, sections, discovery }) with NO computed site score.
 */
export function aggregateSiteScore(scan: SiteScanResult): {
  perPage: PageScanResult[];
  sections: SectionSample[];
  discovery: DiscoveryResult;
} {
  // TODO(Fase 3, pending Alison validation): implement the site-level vs
  // page-level split + aggregation (30/70 + worst-page). Do NOT add scoring
  // math here until the methodology is validated.
  return {
    perPage: scan.perPage,
    sections: scan.sections,
    discovery: scan.discovery,
  };
}
