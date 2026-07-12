import { describe, it, expect } from "vitest";
import { analyzeContext } from "../src/index.js";
import { fixture, buildContext } from "./helpers.js";

describe("schema-rich page", () => {
  const ctx = buildContext(fixture("schema-rich.html"), {
    robotsTxt: fixture("robots-allow-all.txt"),
    llmsTxt: fixture("llms.txt"),
    llmsFull: false,
  });
  const report = analyzeContext(ctx);

  it("is classified OK (content present in raw HTML)", () => {
    expect(report.block.status).toBe("OK");
  });

  it("scores high overall and earns an A/B grade", () => {
    expect(report.total).toBeGreaterThanOrEqual(80);
    expect(["A", "B"]).toContain(report.grade);
  });

  it("gives full-ish crawler access (all AI bots allowed)", () => {
    const d = report.dimensions.aiCrawlerAccess;
    expect(d.signals.aiBotsBlocked).toEqual([]);
    expect(d.score).toBeGreaterThanOrEqual(20);
  });

  it("detects Tier A schema including FAQPage and Organization", () => {
    const d = report.dimensions.structuredData;
    expect(d.signals.tierAMatched).toEqual(
      expect.arrayContaining(["Organization", "Article", "FAQPage", "BreadcrumbList", "WebSite"]),
    );
    expect(d.score).toBeGreaterThanOrEqual(16);
  });

  it("detects author/publisher provenance and dates", () => {
    const d = report.dimensions.metadataProvenance;
    const a = d.signals.authorSignals as { hasSchemaAuthor: boolean; hasSchemaPublisher: boolean };
    expect(a.hasSchemaAuthor).toBe(true);
    expect(a.hasSchemaPublisher).toBe(true);
    expect(d.signals.hasDate).toBe(true);
  });

  it("recognizes a single h1 and clean hierarchy", () => {
    const d = report.dimensions.semanticStructure;
    expect(d.signals.h1Count).toBe(1);
    expect(d.signals.headingSkips).toBe(0);
  });

  it("rewards present, well-formed llms.txt", () => {
    const d = report.dimensions.llmsTxt;
    expect(d.signals.llmsTxtPresent).toBe(true);
    expect(d.signals.llmsTxtWellFormed).toBe(true);
    expect(d.score).toBeGreaterThanOrEqual(7);
  });

  it("produces a strong answer-readiness beta sub-score (separate from core)", () => {
    expect(report.answerReadinessBeta.score).toBeGreaterThanOrEqual(60);
    // Beta is NOT folded into the 100-point total.
    expect(report.total).toBeLessThanOrEqual(100);
  });
});

describe("JS-only shell", () => {
  const ctx = buildContext(fixture("js-only-shell.html"), {
    robotsTxt: fixture("robots-allow-all.txt"),
  });
  const report = analyzeContext(ctx);

  it("is classified SOFT_BLOCK with js_only_shell reason", () => {
    expect(report.block.status).toBe("SOFT_BLOCK");
    expect(report.block.reason).toBe("js_only_shell");
  });

  it("tanks the content extractability dimension", () => {
    expect(report.dimensions.contentExtractability.score).toBeLessThanOrEqual(3);
  });

  it("still returns a deterministic total (no crash)", () => {
    expect(report.total).toBeGreaterThanOrEqual(0);
    expect(report.total).toBeLessThanOrEqual(100);
  });
});

describe("robots.txt blocking AI bots", () => {
  const ctx = buildContext(fixture("schema-rich.html"), {
    robotsTxt: fixture("robots-block-ai.txt"),
  });
  const report = analyzeContext(ctx);
  const d = report.dimensions.aiCrawlerAccess;

  it("reports the specific blocked AI bots", () => {
    expect(d.signals.aiBotsBlocked).toEqual(
      expect.arrayContaining(["GPTBot", "ClaudeBot", "Google-Extended", "CCBot", "PerplexityBot"]),
    );
  });

  it("lowers the crawler-access score materially", () => {
    expect(d.score).toBeLessThan(22);
  });

  it("surfaces a high-severity fix at/near the top", () => {
    const robotsFix = report.fixes.find((f) => f.code === "robots.some_blocked");
    expect(robotsFix).toBeDefined();
    expect(robotsFix?.severity).toBe("high");
  });
});

describe("gated / paywall page", () => {
  const ctx = buildContext(fixture("gated-page.html"), {
    status: 200,
    robotsTxt: fixture("robots-allow-all.txt"),
  });
  const report = analyzeContext(ctx);

  it("is classified SOFT_BLOCK (gated_content) despite HTTP 200", () => {
    expect(report.block.status).toBe("SOFT_BLOCK");
    expect(report.block.reason).toBe("gated_content");
  });
});

describe("bot-challenge interstitial", () => {
  const ctx = buildContext(fixture("challenge-page.html"), { status: 403 });
  const report = analyzeContext(ctx);

  it("is classified HARD_BLOCK", () => {
    expect(report.block.status).toBe("HARD_BLOCK");
    expect(["bot_challenge", "http_403"]).toContain(report.block.reason);
  });
});

describe("plain page (no schema, no lang, thin, double h1)", () => {
  const ctx = buildContext(fixture("plain-page.html"), {
    robotsTxt: fixture("robots-allow-all.txt"),
  });
  const report = analyzeContext(ctx);

  it("scores low overall", () => {
    expect(report.total).toBeLessThan(55);
  });

  it("detects zero structured data", () => {
    expect(report.dimensions.structuredData.score).toBe(0);
  });

  it("flags missing lang and multiple h1", () => {
    expect(report.dimensions.metadataProvenance.signals.lang).toBeNull();
    expect(report.dimensions.semanticStructure.signals.h1Count).toBe(2);
  });

  it("orders fixes impact-first (descending impact)", () => {
    for (let i = 1; i < report.fixes.length; i++) {
      const prev = report.fixes[i - 1]!;
      const cur = report.fixes[i]!;
      expect(prev.impact).toBeGreaterThanOrEqual(cur.impact);
    }
  });
});
