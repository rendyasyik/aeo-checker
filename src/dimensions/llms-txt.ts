/**
 * Dimension 6 — llms.txt discoverability (weight 8).
 *
 * Uses the pre-fetched /llms.txt and /llms-full.txt results from the context.
 * The actual fetching + well-formedness parsing lives in llms-fetch.ts so the
 * orchestrator can do it once.
 */

import { DIMENSION_WEIGHTS, DIMENSION_LABELS } from "../types.js";
import type { AnalysisContext } from "../context.js";
import type { DimensionResult, Finding } from "../types.js";

const MAX = DIMENSION_WEIGHTS.llmsTxt; // 8

export function scoreLlmsTxt(ctx: AnalysisContext): DimensionResult {
  const findings: Finding[] = [];
  const signals: Record<string, unknown> = {};
  const l = ctx.llmsTxt;

  signals.llmsTxtPresent = l.present;
  signals.llmsTxtStatus = l.status;
  signals.llmsTxtWellFormed = l.wellFormed;
  signals.llmsFullPresent = l.fullPresent;

  let score = 0;
  if (l.present) {
    score += 5;
    findings.push({
      code: "llms.present",
      message: "An /llms.txt file is present at the site root.",
      severity: "info",
      positive: true,
    });
    if (l.wellFormed) {
      score += 2;
      findings.push({
        code: "llms.well_formed",
        message: "The llms.txt file is well-formed (H1 title with structured sections/links).",
        severity: "info",
        positive: true,
      });
    } else {
      findings.push({
        code: "llms.malformed",
        message: `The llms.txt file exists but is not well-formed: ${l.detail}`,
        severity: "low",
        positive: false,
      });
    }
    if (l.fullPresent) {
      score += 1;
      findings.push({
        code: "llms.full_present",
        message: "An /llms-full.txt file is also present (full-content variant).",
        severity: "info",
        positive: true,
      });
    }
  } else {
    findings.push({
      code: "llms.absent",
      message:
        "No /llms.txt file was found. Adding one is an emerging way to curate content for LLMs and signal AEO maturity.",
      severity: "medium",
      positive: false,
    });
  }

  score = Math.max(0, Math.min(MAX, score));

  return {
    id: "llmsTxt",
    label: DIMENSION_LABELS.llmsTxt,
    score,
    max: MAX,
    signals,
    findings,
  };
}
