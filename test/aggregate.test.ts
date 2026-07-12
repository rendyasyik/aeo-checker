/**
 * Fase 3, Step 3 — site-score aggregation unit tests.
 *
 * Exercises the FOUR mandatory corrections (fase-3-validasi-metodologi.md)
 * against synthetic per-page reports with KNOWN numbers so the mean/median/
 * stdev/min-max, hard-block exclusion, hybrid AI-access reporting, and the
 * all-blocked degenerate case are all pinned deterministically.
 */

import { describe, it, expect } from "vitest";
import { aggregate } from "../src/site-scan/aggregate.js";
import type { PageScanResult } from "../src/site-scan/orchestrator.js";
import type {
  AeoReport,
  BlockStatus,
  DimensionId,
  DimensionResult,
} from "../src/types.js";
import { DIMENSION_WEIGHTS, DIMENSION_LABELS } from "../src/types.js";
import { gradeForTotal } from "../src/scoring.js";

const HOMEPAGE = "https://example.com/";

interface FakePageOpts {
  url: string;
  block?: BlockStatus;
  httpStatus?: number;
  /** Per-page dimension scores. Missing dimensions default to their max. */
  scores?: Partial<Record<DimensionId, number>>;
  answerReadiness?: number;
  /** AI bots blocked for THIS page's path (robots path disallow). */
  aiBotsBlocked?: string[];
  /** meta-robots / X-Robots-Tag directives detected on this page. */
  directives?: { noindex?: boolean; none?: boolean };
}

function dim(id: DimensionId, score: number, signals: Record<string, unknown> = {}): DimensionResult {
  return {
    id,
    label: DIMENSION_LABELS[id],
    score,
    max: DIMENSION_WEIGHTS[id],
    signals,
    findings: [],
  };
}

/** Build a synthetic AeoReport with controllable dimension scores + AI signals. */
function fakeReport(o: FakePageOpts): AeoReport {
  const s = o.scores ?? {};
  const dimensions = {
    aiCrawlerAccess: dim("aiCrawlerAccess", s.aiCrawlerAccess ?? DIMENSION_WEIGHTS.aiCrawlerAccess, {
      aiBotsBlocked: o.aiBotsBlocked ?? [],
      directives: {
        noindex: o.directives?.noindex ?? false,
        none: o.directives?.none ?? false,
      },
    }),
    contentExtractability: dim("contentExtractability", s.contentExtractability ?? DIMENSION_WEIGHTS.contentExtractability),
    structuredData: dim("structuredData", s.structuredData ?? DIMENSION_WEIGHTS.structuredData),
    semanticStructure: dim("semanticStructure", s.semanticStructure ?? DIMENSION_WEIGHTS.semanticStructure),
    metadataProvenance: dim("metadataProvenance", s.metadataProvenance ?? DIMENSION_WEIGHTS.metadataProvenance),
    llmsTxt: dim("llmsTxt", s.llmsTxt ?? DIMENSION_WEIGHTS.llmsTxt),
  } satisfies Record<DimensionId, DimensionResult>;

  let total = 0;
  for (const d of Object.values(dimensions)) total += d.score;

  return {
    url: o.url,
    finalUrl: o.url,
    fetchedAt: new Date(0).toISOString(),
    total: Math.round(total),
    grade: gradeForTotal(Math.round(total)),
    block: {
      status: o.block ?? "OK",
      httpStatus: o.httpStatus ?? 200,
      reason: o.block === "HARD_BLOCK" ? "http_403" : "ok",
      detail: "",
    },
    dimensions,
    fixes: [],
    answerReadinessBeta: {
      score: o.answerReadiness ?? 50,
      grade: gradeForTotal(o.answerReadiness ?? 50),
      signals: {},
      findings: [],
    },
    notes: [],
  };
}

function page(o: FakePageOpts): PageScanResult {
  return { url: o.url, result: fakeReport(o), error: null };
}

/** The four per-page dimensions summed for a given per-dimension score set. */
function pagePortion(scores: Partial<Record<DimensionId, number>>): number {
  return (
    (scores.contentExtractability ?? DIMENSION_WEIGHTS.contentExtractability) +
    (scores.structuredData ?? DIMENSION_WEIGHTS.structuredData) +
    (scores.semanticStructure ?? DIMENSION_WEIGHTS.semanticStructure) +
    (scores.metadataProvenance ?? DIMENSION_WEIGHTS.metadataProvenance)
  );
}

describe("aggregate: correction 2 — hard-block excluded from mean, reported as coverage gap", () => {
  it("3 pages (1 hard-block, 2 OK) -> mean of the 2 only, coverageGap=1/3", () => {
    const okA = { contentExtractability: 20, structuredData: 18, semanticStructure: 14, metadataProvenance: 10 }; // 62
    const okB = { contentExtractability: 22, structuredData: 20, semanticStructure: 16, metadataProvenance: 12 }; // 70
    const perPage = [
      page({ url: HOMEPAGE, scores: okA }),
      page({ url: "https://example.com/blog/a", scores: okB }),
      page({ url: "https://example.com/blog/b", block: "HARD_BLOCK", httpStatus: 403 }),
    ];
    const r = aggregate(perPage, HOMEPAGE);

    expect(r.siteScore.pageLevel.countedPages).toBe(2);
    expect(r.siteScore.pageLevel.excludedHardBlock).toBe(1);
    // mean of 62 and 70 = 66.
    expect(r.siteScore.pageLevel.mean).toBe(66);
    expect(r.coverageGap.inaccessible).toBe(1);
    expect(r.coverageGap.total).toBe(3);
    expect(r.coverageGap.urls).toEqual(["https://example.com/blog/b"]);
    expect(r.blockDistribution.hardBlock).toEqual(["https://example.com/blog/b"]);
  });

  it("hard-block page is NOT scored 0 (it does not drag the mean down)", () => {
    const good = { contentExtractability: 22, structuredData: 20, semanticStructure: 16, metadataProvenance: 12 }; // 70
    const withBlock = aggregate(
      [page({ url: HOMEPAGE, scores: good }), page({ url: "https://example.com/x", block: "HARD_BLOCK" })],
      HOMEPAGE,
    );
    // Mean is 70 (only the good page counts), not 35 (which a 0-scored block would give).
    expect(withBlock.siteScore.pageLevel.mean).toBe(70);
  });
});

describe("aggregate: correction 2 — soft-block / JS-only IS counted at its low score", () => {
  it("a SOFT_BLOCK page stays in the mean with its (low) portion", () => {
    const good = { contentExtractability: 22, structuredData: 20, semanticStructure: 16, metadataProvenance: 12 }; // 70
    const jsOnly = { contentExtractability: 2, structuredData: 0, semanticStructure: 2, metadataProvenance: 4 }; // 8
    const r = aggregate(
      [
        page({ url: HOMEPAGE, scores: good }),
        page({ url: "https://example.com/app", block: "SOFT_BLOCK", scores: jsOnly }),
      ],
      HOMEPAGE,
    );
    expect(r.siteScore.pageLevel.countedPages).toBe(2);
    expect(r.blockDistribution.softBlock).toEqual(["https://example.com/app"]);
    // mean of 70 and 8 = 39.
    expect(r.siteScore.pageLevel.mean).toBe(39);
    expect(r.coverageGap.inaccessible).toBe(0);
  });
});

describe("aggregate: correction 3 — median + stdev + min-max on known fixtures", () => {
  it("computes mean/median/stdev/min/max correctly", () => {
    // Portions chosen so mean != median (bimodal-ish): 70, 70, 10 -> mean 50, median 70.
    const p = (v: number) => ({ contentExtractability: v, structuredData: 0, semanticStructure: 0, metadataProvenance: 0 });
    const perPage = [
      page({ url: HOMEPAGE, scores: p(70) }),
      page({ url: "https://example.com/a", scores: p(70) }),
      page({ url: "https://example.com/b", scores: p(10) }),
    ];
    const r = aggregate(perPage, HOMEPAGE);
    const pl = r.siteScore.pageLevel;
    expect(pl.mean).toBe(50); // (70+70+10)/3
    expect(pl.median).toBe(70); // sorted 10,70,70 -> middle 70
    expect(pl.min).toBe(10);
    expect(pl.max).toBe(70);
    // population stdev of [70,70,10]: variance = ((20^2)+(20^2)+(40^2))/3 = (400+400+1600)/3 = 800; sqrt = 28.28...
    expect(pl.stdev).toBeCloseTo(28.3, 1);
  });
});

describe("aggregate: correction 2 tail — ALL hard-block -> honest null page-level", () => {
  it("returns null total/grade + an honest unscorable reason", () => {
    const perPage = [
      page({ url: HOMEPAGE, block: "HARD_BLOCK", httpStatus: 403 }),
      page({ url: "https://example.com/a", block: "HARD_BLOCK", httpStatus: 429 }),
    ];
    const r = aggregate(perPage, HOMEPAGE);
    expect(r.siteScore.pageLevel.mean).toBeNull();
    expect(r.siteScore.total).toBeNull();
    expect(r.siteScore.grade).toBeNull();
    expect(r.siteScore.unscorableReason).toBeTruthy();
    expect(r.coverageGap.inaccessible).toBe(2);
    expect(r.worstPage).toBeNull();
    // Site-level signals from the (blocked) homepage report are still exposed.
    expect(r.siteScore.siteLevel.max).toBe(30);
  });
});

describe("aggregate: correction 1 — hybrid AI-crawler reporting on HTTP 200 pages", () => {
  it("robots-path-disallowed page surfaces in blockDistribution despite HTTP 200", () => {
    const r = aggregate(
      [
        page({ url: HOMEPAGE }),
        page({ url: "https://example.com/private", aiBotsBlocked: ["GPTBot", "ClaudeBot"] }),
      ],
      HOMEPAGE,
    );
    expect(r.blockDistribution.robotsDisallowed).toContain("https://example.com/private");
    // Still counted (HTTP 200, real content) — hybrid is a REPORT, not a mean exclusion.
    expect(r.siteScore.pageLevel.countedPages).toBe(2);
  });

  it("meta-noindex page surfaces in blockDistribution despite HTTP 200", () => {
    const r = aggregate(
      [
        page({ url: HOMEPAGE }),
        page({ url: "https://example.com/noindex", directives: { noindex: true } }),
      ],
      HOMEPAGE,
    );
    expect(r.blockDistribution.metaNoindex).toContain("https://example.com/noindex");
    expect(r.siteScore.pageLevel.countedPages).toBe(2);
  });
});

describe("aggregate: correction 4 — estimate label + sampled pages + counts", () => {
  it("isEstimate true, sampledPages populated, counted vs excluded correct", () => {
    const perPage = [
      page({ url: HOMEPAGE }),
      page({ url: "https://example.com/blog/a" }),
      page({ url: "https://example.com/blog/b", block: "HARD_BLOCK" }),
    ];
    const r = aggregate(perPage, HOMEPAGE);
    expect(r.siteScore.isEstimate).toBe(true);
    expect(r.sampledPages.length).toBe(3);
    const counted = r.sampledPages.filter((s) => s.counted).length;
    const excluded = r.sampledPages.filter((s) => !s.counted).length;
    expect(counted).toBe(2);
    expect(excluded).toBe(1);
    // Each sampled page carries its section for transparency.
    const blogA = r.sampledPages.find((s) => s.url === "https://example.com/blog/a");
    expect(blogA?.section).toBe("blog");
  });
});

describe("aggregate: site-level judged ONCE from root (not double-counted per page)", () => {
  it("site-level subtotal equals the homepage robots+llms, independent of page count", () => {
    const siteSignals = { aiCrawlerAccess: 20, llmsTxt: 8 }; // homepage site-level = 28
    // Two sites: same homepage site-level, different page counts. Subtotal must match.
    const one = aggregate([page({ url: HOMEPAGE, scores: siteSignals })], HOMEPAGE);
    const many = aggregate(
      [
        page({ url: HOMEPAGE, scores: siteSignals }),
        page({ url: "https://example.com/a", scores: { aiCrawlerAccess: 0, llmsTxt: 0 } }),
        page({ url: "https://example.com/b", scores: { aiCrawlerAccess: 0, llmsTxt: 0 } }),
      ],
      HOMEPAGE,
    );
    expect(one.siteScore.siteLevel.subtotal).toBe(28);
    expect(many.siteScore.siteLevel.subtotal).toBe(28); // NOT summed across pages
    expect(many.siteScore.siteLevel.source).toBe(HOMEPAGE);
    // Total = site-level (28) + page-level mean. Confirm it uses the mean, not a per-page site-level sum.
    expect(one.siteScore.total).toBe(28 + (one.siteScore.pageLevel.mean as number));
  });
});
