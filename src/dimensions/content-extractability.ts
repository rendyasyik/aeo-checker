/**
 * Dimension 2 — Content Extractability without JS (weight 22).
 *
 * Measures whether the core content is present in the raw HTML (not a shell
 * that hydrates via JS). Uses word count, main/article text, text-to-HTML
 * ratio, and the JS-only-shell heuristic. This mirrors what an AI crawler,
 * which does not run JS, actually sees.
 */

import { DIMENSION_WEIGHTS, DIMENSION_LABELS } from "../types.js";
import { isJsOnlyShell } from "../block-detect.js";
import type { AnalysisContext } from "../context.js";
import type { DimensionResult, Finding } from "../types.js";

const MAX = DIMENSION_WEIGHTS.contentExtractability; // 22

export function scoreContentExtractability(
  ctx: AnalysisContext,
): DimensionResult {
  const findings: Finding[] = [];
  const signals: Record<string, unknown> = {};
  const p = ctx.parsed;

  signals.wordCount = p.wordCount;
  signals.mainWordCount = p.mainWordCount;
  signals.textToHtmlRatio = Math.round(p.textToHtmlRatio * 1000) / 1000;
  signals.scriptCount = p.scriptCount;
  signals.hasMainOrArticle =
    p.root.querySelector("main") !== null ||
    p.root.querySelector("article") !== null;

  const shell = isJsOnlyShell(p);
  signals.jsOnlyShell = shell.jsOnly;
  if (shell.jsOnly) signals.jsOnlyReason = shell.reason;

  // Hard fail path: JS-only shell => content invisible to crawler.
  if (shell.jsOnly) {
    findings.push({
      code: "extract.js_only",
      message: `The content appears to be rendered by JavaScript (${shell.reason}). AI crawlers see an almost-empty page.`,
      severity: "critical",
      positive: false,
    });
    return {
      id: "contentExtractability",
      label: DIMENSION_LABELS.contentExtractability,
      score: 2,
      max: MAX,
      signals,
      findings,
    };
  }

  // Sub-scores: word count (10), main/article presence (6), ratio (6).
  let wcScore = 0;
  if (p.wordCount >= 600) wcScore = 10;
  else if (p.wordCount >= 300) wcScore = 8;
  else if (p.wordCount >= 150) wcScore = 6;
  else if (p.wordCount >= 60) wcScore = 3;
  else wcScore = 1;

  if (p.wordCount < 150) {
    findings.push({
      code: "extract.thin_content",
      message: `Only about ${p.wordCount} words of text are present in the raw HTML; there may be little for an AI crawler to extract.`,
      severity: p.wordCount < 60 ? "high" : "medium",
      positive: false,
    });
  } else {
    findings.push({
      code: "extract.has_text",
      message: `About ${p.wordCount} words of content are present in the raw HTML.`,
      severity: "info",
      positive: true,
    });
  }

  let mainScore = 0;
  if (signals.hasMainOrArticle && p.mainWordCount >= 150) {
    mainScore = 6;
    findings.push({
      code: "extract.main_landmark",
      message: `The main content is inside a <main>/<article> landmark (${p.mainWordCount} words).`,
      severity: "info",
      positive: true,
    });
  } else if (signals.hasMainOrArticle && p.mainWordCount > 0) {
    mainScore = 4;
  } else {
    mainScore = 2;
    findings.push({
      code: "extract.no_main",
      message:
        "No substantial <main> or <article> landmark was found; content boundaries are less clear to extractors.",
      severity: "low",
      positive: false,
    });
  }

  // Text-to-HTML ratio: healthy content pages usually sit well above 0.05.
  let ratioScore = 0;
  const r = p.textToHtmlRatio;
  if (r >= 0.15) ratioScore = 6;
  else if (r >= 0.08) ratioScore = 5;
  else if (r >= 0.04) ratioScore = 3;
  else if (r >= 0.02) ratioScore = 2;
  else ratioScore = 0;

  if (r < 0.04) {
    findings.push({
      code: "extract.low_ratio",
      message: `The visible-text-to-HTML ratio is low (${(r * 100).toFixed(1)}%), suggesting heavy markup relative to readable content.`,
      severity: "low",
      positive: false,
    });
  }

  const score = Math.max(0, Math.min(MAX, wcScore + mainScore + ratioScore));

  return {
    id: "contentExtractability",
    label: DIMENSION_LABELS.contentExtractability,
    score,
    max: MAX,
    signals,
    findings,
  };
}
