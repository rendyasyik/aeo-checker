/**
 * Tests for the MCP substrate surface: analyzeContext(..., {
 * includeExtractedContent: true }) attaches `extractedContent` with the
 * readable text an AI crawler sees plus deterministic answer-structure signals.
 * Off by default (Worker contract unchanged); safe on blocked pages; capped.
 */

import { describe, it, expect } from "vitest";
import { analyzeContext } from "../src/index.js";
import { MAX_EXTRACTED_CONTENT_CHARS } from "../src/types.js";
import { buildContext, fixture } from "./helpers.js";

describe("extractedContent (MCP substrate)", () => {
  it("is absent by default (Worker contract unchanged)", () => {
    const report = analyzeContext(buildContext(fixture("schema-rich.html")));
    expect(report.extractedContent).toBeUndefined();
  });

  it("normal page: mainText filled + answerStructure signals surfaced", () => {
    const report = analyzeContext(buildContext(fixture("schema-rich.html")), {
      includeExtractedContent: true,
    });
    const ec = report.extractedContent;
    expect(ec).toBeDefined();
    if (!ec) return;

    // Readable text is present and matches what an AI crawler sees.
    expect(ec.mainText.length).toBeGreaterThan(100);
    expect(ec.mainText).toContain("Answer engine optimization");
    expect(ec.blocked).toBe(false);
    expect(ec.truncated).toBe(false);
    expect(ec.originalLength).toBe(ec.mainText.length);
    expect(ec.wordCount).toBeGreaterThan(50);

    // Structural signals surfaced verbatim from the answer-readiness detector.
    expect(ec.answerStructure.faqSchema).toBe(true);
    expect(ec.answerStructure.questionHeadingCount).toBeGreaterThanOrEqual(3);
    expect(ec.answerStructure.answerParagraphCount).toBeGreaterThanOrEqual(1);
    expect(ec.answerStructure.orderedListCount).toBe(1);
    expect(typeof ec.answerStructure.howToSchema).toBe("boolean");
    expect(typeof ec.answerStructure.faqBlock).toBe("boolean");
    expect(typeof ec.answerStructure.tldr).toBe("boolean");
  });

  it("surfaced signals match the scored answer-readiness beta signals", () => {
    const report = analyzeContext(buildContext(fixture("schema-rich.html")), {
      includeExtractedContent: true,
    });
    const ec = report.extractedContent;
    const beta = report.answerReadinessBeta.signals;
    expect(ec).toBeDefined();
    if (!ec) return;
    // No divergence: surfaced values equal the detector's own signals.
    expect(ec.answerStructure.faqSchema).toBe(beta.faqSchema);
    expect(ec.answerStructure.faqBlock).toBe(beta.faqBlock);
    expect(ec.answerStructure.questionHeadingCount).toBe(
      beta.questionHeadingCount,
    );
    expect(ec.answerStructure.answerParagraphCount).toBe(beta.answerParagraphs);
    expect(ec.answerStructure.tldr).toBe(beta.tldr);
    expect(ec.answerStructure.orderedListCount).toBe(beta.orderedListCount);
    expect(ec.answerStructure.howToSchema).toBe(beta.howToSchema);
  });

  it("empty / minimal page: does not crash, mainText empty, signals zeroed", () => {
    const report = analyzeContext(
      buildContext("<!DOCTYPE html><html><head></head><body></body></html>"),
      { includeExtractedContent: true },
    );
    const ec = report.extractedContent;
    expect(ec).toBeDefined();
    if (!ec) return;
    expect(ec.mainText).toBe("");
    expect(ec.originalLength).toBe(0);
    expect(ec.truncated).toBe(false);
    expect(ec.answerStructure.questionHeadingCount).toBe(0);
    expect(ec.answerStructure.faqSchema).toBe(false);
    expect(ec.answerStructure.answerParagraphCount).toBe(0);
  });

  it("blocked page (HARD_BLOCK): extractedContent still consistent + blocked flag", () => {
    const report = analyzeContext(
      buildContext(fixture("challenge-page.html")),
      { includeExtractedContent: true },
    );
    expect(report.block.status).not.toBe("OK");
    const ec = report.extractedContent;
    expect(ec).toBeDefined();
    if (!ec) return;
    expect(ec.blocked).toBe(true);
    // Should not crash; structural signals are still well-formed types.
    expect(typeof ec.mainText).toBe("string");
    expect(typeof ec.answerStructure.questionHeadingCount).toBe("number");
  });

  it("caps long text at MAX_EXTRACTED_CONTENT_CHARS and sets truncated", () => {
    const filler = "word ".repeat(20000); // ~100k chars of readable text
    const html = `<!DOCTYPE html><html><head><title>Long</title></head><body><main><h1>Long page</h1><p>${filler}</p></main></body></html>`;
    const report = analyzeContext(buildContext(html), {
      includeExtractedContent: true,
    });
    const ec = report.extractedContent;
    expect(ec).toBeDefined();
    if (!ec) return;
    expect(ec.truncated).toBe(true);
    expect(ec.mainText.length).toBe(MAX_EXTRACTED_CONTENT_CHARS);
    expect(ec.originalLength).toBeGreaterThan(MAX_EXTRACTED_CONTENT_CHARS);
  });
});
