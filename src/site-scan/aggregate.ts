/**
 * Site-scan SCORE AGGREGATION (Fase 3, Step 3).
 *
 * Rolls per-page single-page reports + site-level signals into one honest,
 * site-level AI-readiness score. Implements the FINAL methodology validated by
 * Alison (fase-3-validasi-metodologi.md) with its four mandatory corrections.
 *
 * Design (source of truth = the validation doc, do NOT re-weight dimensions):
 *
 *   Site score (0-100) = SITE-LEVEL (30) + PAGE-LEVEL (70)
 *
 *   SITE-LEVEL (30, judged ONCE from the root — the two file-root, site-wide
 *   dimensions): AI Crawler Access (22) + llms.txt (8). Taken from the HOMEPAGE
 *   report (root of the site) so robots.txt + llms.txt are scored exactly once,
 *   never double-counted per page.
 *
 *   PAGE-LEVEL (70, MEAN across counted pages of the four per-page dimensions):
 *   Content Extractability (22) + Structured Data (20) + Semantic Structure (16)
 *   + Metadata/Provenance (12). Averaged across the sampled pages that COUNT.
 *
 * Four corrections, all reporting/aggregation only:
 *   1. AI Crawler Access is HYBRID — robots.txt global rules feed the site-level
 *      22, but every sampled page is ALSO checked for path-level robots disallow
 *      + meta-robots / X-Robots-Tag noindex/nosnippet/noai, and any individually
 *      blocked page surfaces in `blockDistribution` (never hidden behind the
 *      site-level tick). Bobot skor tetap dari robots global.
 *   2. HARD_BLOCK pages (HTTP 401/403/429/503/bot-challenge/network) are
 *      EXCLUDED from the page-level mean (NOT scored 0) and reported as a
 *      coverage gap. SOFT_BLOCK / JS-only (HTTP 200 but empty/gated) is a REAL
 *      extractability failure: kept with its low score and INCLUDED in the mean.
 *   3. Mean is the headline, but median + stdev + min-max are always reported so
 *      a bimodal site cannot hide behind one number.
 *   4. The site score is LABELLED an ESTIMATE from N sampled pages (isEstimate),
 *      with counted-vs-excluded counts and the sampled URL list + sections.
 */

import type { AeoReport, Grade } from "../types.js";
import { gradeForTotal } from "../scoring.js";
import { sectionOf } from "./sampling.js";
import type { PageScanResult } from "./orchestrator.js";

/** Site-level subtotal detail (robots + llms.txt, judged once from root). */
export interface SiteLevelScore {
  /** AI Crawler Access dimension score from the root report (out of 22). */
  aiCrawlerAccess: number;
  /** llms.txt dimension score from the root report (out of 8). */
  llmsTxt: number;
  /** Sum of the two site-level dimensions (out of 30). */
  subtotal: number;
  /** Fixed maximum of the site-level portion. */
  max: 30;
  /** Which URL supplied the root/site-level signals (the homepage if present). */
  source: string | null;
}

/** Page-level subtotal detail: MEAN headline + median + spread (corrections 2 & 3). */
export interface PageLevelScore {
  /** Headline: MEAN of counted pages' page-level (0-70) portion. Null if none counted. */
  mean: number | null;
  /** Median of counted pages' page-level portion. Null if none counted. */
  median: number | null;
  /** Population standard deviation across counted pages. Null if <1 counted. */
  stdev: number | null;
  /** Minimum counted page-level portion. Null if none counted. */
  min: number | null;
  /** Maximum counted page-level portion. Null if none counted. */
  max: number | null;
  /** The mean, scaled/kept on the 0-70 page-level subtotal. Same as `mean`. */
  subtotal: number | null;
  /** Fixed maximum of the page-level portion. */
  maxPossible: 70;
  /** Pages that COUNTED toward the mean (OK + SOFT_BLOCK). */
  countedPages: number;
  /** Pages EXCLUDED from the mean because they were HARD_BLOCK. */
  excludedHardBlock: number;
}

/** The aggregated, honest site score. Replaces the old `siteScore: null`. */
export interface SiteScore {
  /** 0-100 combined site score, or null when NO page could be scored. */
  total: number | null;
  /** Letter grade for `total`, or null when un-scorable. */
  grade: Grade | null;
  /** Site-level (robots + llms.txt) portion, judged once from the root. */
  siteLevel: SiteLevelScore;
  /** Page-level (4 per-page dimensions) mean + spread across counted pages. */
  pageLevel: PageLevelScore;
  /** Correction 4: this is an estimate from a sample, not a census. */
  isEstimate: true;
  /**
   * Honest status when the whole site is inaccessible: null means every sampled
   * page hard-blocked, so no page-level score exists. Non-null gives a plain
   * explanation string; null here means a normal, scorable result.
   */
  unscorableReason: string | null;
}

/** Answer-readiness beta aggregated SEPARATELY (mean across counted pages, out of 100). */
export interface AnswerReadinessBetaAggregate {
  /** Mean structural answer-readiness across counted pages. Null if none counted. */
  mean: number | null;
  median: number | null;
  min: number | null;
  max: number | null;
  countedPages: number;
}

/** Correction 1 + 2: honest distribution of what blocked what, per URL. */
export interface BlockDistribution {
  /** HTTP 401/403/429/503 / bot-challenge / network error — excluded from mean. */
  hardBlock: string[];
  /** HTTP 200 but empty/JS-only/gated — kept in the mean with a low score. */
  softBlock: string[];
  /** Path disallowed for AI bots by robots.txt (still HTTP 200) — surfaced honestly. */
  robotsDisallowed: string[];
  /** meta-robots or X-Robots-Tag noindex/none on the page (still HTTP 200). */
  metaNoindex: string[];
}

/** Correction 2: coverage gap — the pages an AI crawler simply could not access. */
export interface CoverageGap {
  /** Pages that hard-blocked (could not be assessed). */
  inaccessible: number;
  /** Total pages sampled + attempted. */
  total: number;
  /** The inaccessible URLs, for transparency. */
  urls: string[];
}

/** Worst counted page — DIAGNOSTIC ONLY, no extra weight to the score. */
export interface WorstPage {
  url: string;
  /** Full single-page total (0-100) of that page, for context. */
  total: number;
}

/** Per-sampled-page summary line (correction 4 transparency). */
export interface SampledPage {
  url: string;
  section: string;
  /** Full single-page total (0-100), or null if the page could not be scored. */
  total: number | null;
  /** Block classification for this page. */
  block: AeoReport["block"]["status"] | "ERROR";
  /** Whether this page counted toward the page-level mean. */
  counted: boolean;
}

/** The full aggregated site-scan result payload (score + honesty fields). */
export interface SiteScoreResult {
  siteScore: SiteScore;
  answerReadinessBeta: AnswerReadinessBetaAggregate;
  blockDistribution: BlockDistribution;
  coverageGap: CoverageGap;
  /** Worst counted page (diagnostic). Null if no page counted. */
  worstPage: WorstPage | null;
  /** Every sampled page with its section + score + block, for transparency. */
  sampledPages: SampledPage[];
}

/** The four per-page dimensions that make up the 70-point page-level portion. */
const PAGE_LEVEL_DIMENSIONS = [
  "contentExtractability",
  "structuredData",
  "semanticStructure",
  "metadataProvenance",
] as const;

/** Sum the four per-page dimension scores from a report (0-70). */
function pageLevelPortion(report: AeoReport): number {
  let sum = 0;
  for (const dim of PAGE_LEVEL_DIMENSIONS) {
    sum += report.dimensions[dim]?.score ?? 0;
  }
  return sum;
}

/** Mean of a non-empty number list. */
function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Median of a non-empty number list (average of the two middle values for even n). */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? ((s[mid - 1] as number) + (s[mid] as number)) / 2 : (s[mid] as number);
}

/** Population standard deviation of a number list (0 for a single element). */
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  const variance = xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length;
  return Math.sqrt(variance);
}

/** Round to one decimal place. */
function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/**
 * CORRECTION 1 (hybrid, reporting side): read the per-page robots-path-allow +
 * meta/header directives that the AI-crawler-access dimension already computed
 * per page, so individually-blocked pages surface in blockDistribution even on
 * HTTP 200. We reuse the dimension's own signals rather than re-fetching — the
 * page report already evaluated robots.txt against the page path and parsed the
 * page's <meta name="robots"> + X-Robots-Tag header.
 */
function pageAiAccessFlags(report: AeoReport): {
  robotsDisallowed: boolean;
  metaNoindex: boolean;
} {
  const signals = report.dimensions.aiCrawlerAccess?.signals ?? {};

  // (a) robots.txt path-level disallow for AI bots: the dimension records the
  // list of AI bots blocked for THIS page's path. Any non-empty list means the
  // page path is disallowed for at least one tracked AI crawler.
  const blocked = signals.aiBotsBlocked;
  const robotsDisallowed = Array.isArray(blocked) && blocked.length > 0;

  // (b) meta-robots / X-Robots-Tag noindex/none on the page itself.
  const directives = signals.directives as
    | { noindex?: boolean; none?: boolean }
    | undefined;
  const metaNoindex = !!(directives && (directives.noindex || directives.none));

  return { robotsDisallowed, metaNoindex };
}

/**
 * Aggregate raw per-page reports + metadata into the honest site score.
 *
 * @param perPage  raw per-page scan results (report or error placeholder)
 * @param homepage the site homepage URL, used to pick the root site-level signals
 */
export function aggregate(
  perPage: PageScanResult[],
  homepage: string,
): SiteScoreResult {
  // --- Classify every sampled page honestly. -------------------------------
  const sampledPages: SampledPage[] = [];
  const hardBlockUrls: string[] = [];
  const softBlockUrls: string[] = [];
  const robotsDisallowedUrls: string[] = [];
  const metaNoindexUrls: string[] = [];

  // Page-level portions of pages that COUNT (OK + SOFT_BLOCK). HARD_BLOCK and
  // errors are excluded (correction 2), never scored 0.
  const countedPortions: number[] = [];
  const countedTotals: { url: string; total: number }[] = [];
  const countedAnswerReadiness: number[] = [];

  for (const p of perPage) {
    const url = p.url;
    const section = sectionOf(url);

    if (p.result === null) {
      // A hard failure to scan (thrown/network) is treated as HARD_BLOCK:
      // inaccessible, not "bad". Excluded from the mean.
      hardBlockUrls.push(url);
      sampledPages.push({ url, section, total: null, block: "ERROR", counted: false });
      continue;
    }

    const report = p.result;
    const status = report.block.status;

    // Hybrid per-page flags (correction 1) — surfaced even when HTTP 200.
    const flags = pageAiAccessFlags(report);
    if (flags.robotsDisallowed) robotsDisallowedUrls.push(url);
    if (flags.metaNoindex) metaNoindexUrls.push(url);

    if (status === "HARD_BLOCK") {
      // Correction 2: excluded from the mean, reported as coverage gap.
      hardBlockUrls.push(url);
      sampledPages.push({ url, section, total: report.total, block: status, counted: false });
      continue;
    }

    // OK or SOFT_BLOCK: counts toward the page-level mean (correction 2 — a
    // JS-only/gated page is a REAL extractability failure, kept at its low score).
    if (status === "SOFT_BLOCK") softBlockUrls.push(url);

    const portion = pageLevelPortion(report);
    countedPortions.push(portion);
    countedTotals.push({ url, total: report.total });
    countedAnswerReadiness.push(report.answerReadinessBeta.score);
    sampledPages.push({ url, section, total: report.total, block: status, counted: true });
  }

  // --- SITE-LEVEL (30): robots + llms.txt, judged ONCE from the root. -------
  // Prefer the homepage report; fall back to the first report that has one so a
  // site whose homepage hard-blocked can still expose site-wide robots/llms.txt.
  const homepageReport = perPage.find((p) => p.url === homepage && p.result)?.result ?? null;
  const rootReport = homepageReport ?? perPage.find((p) => p.result)?.result ?? null;

  const aiAccess = rootReport?.dimensions.aiCrawlerAccess?.score ?? 0;
  const llmsTxt = rootReport?.dimensions.llmsTxt?.score ?? 0;
  const siteLevelSubtotal = round1(aiAccess + llmsTxt);

  const siteLevel: SiteLevelScore = {
    aiCrawlerAccess: round1(aiAccess),
    llmsTxt: round1(llmsTxt),
    subtotal: siteLevelSubtotal,
    max: 30,
    source: rootReport ? (homepageReport ? homepage : rootReport.url) : null,
  };

  // --- PAGE-LEVEL (70): mean + spread across counted pages. -----------------
  const counted = countedPortions.length;
  const pageLevel: PageLevelScore = {
    mean: counted > 0 ? round1(mean(countedPortions)) : null,
    median: counted > 0 ? round1(median(countedPortions)) : null,
    stdev: counted > 0 ? round1(stdev(countedPortions)) : null,
    min: counted > 0 ? round1(Math.min(...countedPortions)) : null,
    max: counted > 0 ? round1(Math.max(...countedPortions)) : null,
    subtotal: counted > 0 ? round1(mean(countedPortions)) : null,
    maxPossible: 70,
    countedPages: counted,
    excludedHardBlock: hardBlockUrls.length,
  };

  // --- Combined total + honest un-scorable case. ----------------------------
  let total: number | null;
  let grade: Grade | null;
  let unscorableReason: string | null;

  if (counted === 0) {
    // Correction 2 tail: EVERY sampled page hard-blocked. Do NOT fabricate a
    // page-level score. The site is not assessable for content readiness.
    total = null;
    grade = null;
    unscorableReason =
      rootReport
        ? "Every sampled page was hard-blocked (401/403/429/503/challenge). Only site-level robots.txt/llms.txt signals could be read; page-level content readiness could not be assessed."
        : "The site could not be accessed at all (no page returned readable content), so no AI-readiness score could be computed.";
  } else {
    total = Math.round(siteLevelSubtotal + (pageLevel.mean as number));
    total = Math.max(0, Math.min(100, total));
    grade = gradeForTotal(total);
    unscorableReason = null;
  }

  const siteScore: SiteScore = {
    total,
    grade,
    siteLevel,
    pageLevel,
    isEstimate: true,
    unscorableReason,
  };

  // --- Answer-readiness beta, aggregated SEPARATELY (out of 100). -----------
  const arCounted = countedAnswerReadiness.length;
  const answerReadinessBeta: AnswerReadinessBetaAggregate = {
    mean: arCounted > 0 ? round1(mean(countedAnswerReadiness)) : null,
    median: arCounted > 0 ? round1(median(countedAnswerReadiness)) : null,
    min: arCounted > 0 ? round1(Math.min(...countedAnswerReadiness)) : null,
    max: arCounted > 0 ? round1(Math.max(...countedAnswerReadiness)) : null,
    countedPages: arCounted,
  };

  // --- Block distribution + coverage gap (honesty). -------------------------
  const blockDistribution: BlockDistribution = {
    hardBlock: hardBlockUrls,
    softBlock: softBlockUrls,
    robotsDisallowed: robotsDisallowedUrls,
    metaNoindex: metaNoindexUrls,
  };

  const coverageGap: CoverageGap = {
    inaccessible: hardBlockUrls.length,
    total: perPage.length,
    urls: hardBlockUrls,
  };

  // --- Worst counted page (DIAGNOSTIC only, no score weight). ---------------
  let worstPage: WorstPage | null = null;
  for (const c of countedTotals) {
    if (worstPage === null || c.total < worstPage.total) {
      worstPage = { url: c.url, total: c.total };
    }
  }

  return {
    siteScore,
    answerReadinessBeta,
    blockDistribution,
    coverageGap,
    worstPage,
    sampledPages,
  };
}
