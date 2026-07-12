/**
 * Dimension 4 — Semantic Content Structure (weight 16).
 *
 * Checks: single <h1>, non-skipping heading hierarchy, a descriptive <title>,
 * semantic landmarks (main/article/nav/header/footer), presence of lists/tables,
 * and reasonable content length. Clear structure helps machines segment and
 * extract passages for answers.
 */

import { DIMENSION_WEIGHTS, DIMENSION_LABELS } from "../types.js";
import type { AnalysisContext } from "../context.js";
import type { DimensionResult, Finding } from "../types.js";

const MAX = DIMENSION_WEIGHTS.semanticStructure; // 16

export function scoreSemanticStructure(ctx: AnalysisContext): DimensionResult {
  const findings: Finding[] = [];
  const signals: Record<string, unknown> = {};
  const root = ctx.parsed.root;

  // --- Headings (up to 6) ---
  const h1s = root.querySelectorAll("h1");
  const headings = root.querySelectorAll("h1, h2, h3, h4, h5, h6");
  const levels = headings.map((h) => Number(h.rawTagName.replace(/\D/g, "")));
  signals.h1Count = h1s.length;
  signals.headingCount = headings.length;

  let headingScore = 0;
  if (h1s.length === 1) {
    headingScore += 3;
    findings.push({
      code: "structure.single_h1",
      message: "The page has exactly one <h1>.",
      severity: "info",
      positive: true,
    });
  } else if (h1s.length === 0) {
    findings.push({
      code: "structure.no_h1",
      message: "No <h1> was found; the page lacks a clear primary heading.",
      severity: "medium",
      positive: false,
    });
  } else {
    headingScore += 1;
    findings.push({
      code: "structure.multiple_h1",
      message: `The page has ${h1s.length} <h1> elements; a single primary heading is clearer for extractors.`,
      severity: "low",
      positive: false,
    });
  }

  // Hierarchy: penalize skips (e.g. h2 -> h4).
  let skips = 0;
  let prev = 0;
  for (const lvl of levels) {
    if (prev !== 0 && lvl > prev + 1) skips++;
    prev = lvl;
  }
  signals.headingSkips = skips;
  if (headings.length >= 2) {
    if (skips === 0) {
      headingScore += 3;
      findings.push({
        code: "structure.hierarchy_ok",
        message: "Heading levels follow a logical hierarchy without skipping levels.",
        severity: "info",
        positive: true,
      });
    } else {
      headingScore += 1;
      findings.push({
        code: "structure.hierarchy_skips",
        message: `Heading hierarchy skips levels ${skips} time(s), which can confuse passage segmentation.`,
        severity: "low",
        positive: false,
      });
    }
  }

  // --- Title (up to 3) ---
  const titleEl = root.querySelector("title");
  const title = (titleEl?.text ?? "").trim();
  signals.title = title || null;
  signals.titleLength = title.length;
  let titleScore = 0;
  if (title.length >= 15 && title.length <= 70) {
    titleScore = 3;
  } else if (title.length > 0) {
    titleScore = 1;
    findings.push({
      code: "structure.title_length",
      message: `The <title> is ${title.length} characters; roughly 15-70 is ideal for a descriptive, non-truncated title.`,
      severity: "low",
      positive: false,
    });
  } else {
    findings.push({
      code: "structure.no_title",
      message: "The page has no <title>.",
      severity: "high",
      positive: false,
    });
  }

  // --- Landmarks (up to 3) ---
  const landmarks = {
    main: root.querySelector("main") !== null,
    article: root.querySelector("article") !== null,
    nav: root.querySelector("nav") !== null,
    header: root.querySelector("header") !== null,
    footer: root.querySelector("footer") !== null,
  };
  signals.landmarks = landmarks;
  const landmarkCount = Object.values(landmarks).filter(Boolean).length;
  let landmarkScore = 0;
  if (landmarkCount >= 3) landmarkScore = 3;
  else if (landmarkCount >= 1) landmarkScore = 2;
  else landmarkScore = 0;
  if (landmarkCount === 0) {
    findings.push({
      code: "structure.no_landmarks",
      message: "No semantic landmarks (main/article/nav/header/footer) were found; use them to mark content regions.",
      severity: "medium",
      positive: false,
    });
  } else if (!landmarks.main && !landmarks.article) {
    findings.push({
      code: "structure.no_main_landmark",
      message: "Add a <main> or <article> landmark to mark the primary content region.",
      severity: "low",
      positive: false,
    });
  }

  // --- Lists / tables (up to 2) ---
  const listCount = root.querySelectorAll("ul, ol").length;
  const tableCount = root.querySelectorAll("table").length;
  signals.listCount = listCount;
  signals.tableCount = tableCount;
  let listScore = 0;
  if (listCount + tableCount >= 1) listScore = 2;
  if (listCount + tableCount === 0) {
    findings.push({
      code: "structure.no_lists",
      message: "No lists or tables were found; structured lists are easy for AI to lift into answers.",
      severity: "low",
      positive: false,
    });
  }

  // --- Content length (up to 1, complements dimension 2) ---
  let lengthScore = 0;
  if (ctx.parsed.wordCount >= 300) lengthScore = 1;

  const score = Math.max(
    0,
    Math.min(MAX, headingScore + titleScore + landmarkScore + listScore + lengthScore),
  );

  return {
    id: "semanticStructure",
    label: DIMENSION_LABELS.semanticStructure,
    score,
    max: MAX,
    signals,
    findings,
  };
}
