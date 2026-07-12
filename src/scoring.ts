/**
 * Aggregation: turn per-dimension results into a total, a letter grade, and an
 * impact-first list of fixes. Deterministic.
 */

import type {
  DimensionResult,
  DimensionId,
  Fix,
  Grade,
  Finding,
  Severity,
} from "./types.js";

export function gradeForTotal(total: number): Grade {
  if (total >= 85) return "A";
  if (total >= 70) return "B";
  if (total >= 55) return "C";
  if (total >= 40) return "D";
  return "F";
}

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
};

/**
 * Build an impact-first fix list. Each negative finding becomes a fix; its
 * impact is estimated from the points left on the table in its dimension,
 * weighted by severity, so the biggest wins float to the top.
 */
export function buildFixes(
  dimensions: Record<DimensionId, DimensionResult>,
): Fix[] {
  const fixes: Fix[] = [];

  for (const dim of Object.values(dimensions)) {
    const gap = dim.max - dim.score; // headroom in this dimension
    const negatives = dim.findings.filter((f) => !f.positive);
    if (negatives.length === 0) continue;

    // Distribute the gap across negatives, weighted by severity.
    const totalWeight = negatives.reduce(
      (acc, f) => acc + SEVERITY_RANK[f.severity],
      0,
    );
    for (const f of negatives) {
      const share = totalWeight > 0 ? SEVERITY_RANK[f.severity] / totalWeight : 0;
      // Even a fully-scored dimension can have advisory fixes; give a small floor.
      const impact = Math.round((gap * share + 0.01) * 10) / 10;
      fixes.push({
        code: f.code,
        message: toImperative(f),
        dimension: dim.id,
        impact,
        severity: f.severity,
      });
    }
  }

  fixes.sort((a, b) => {
    if (b.impact !== a.impact) return b.impact - a.impact;
    return SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
  });

  return fixes;
}

/** Turn a finding message into an actionable recommendation where possible. */
function toImperative(f: Finding): string {
  return f.message;
}

export function computeTotal(
  dimensions: Record<DimensionId, DimensionResult>,
): number {
  let total = 0;
  for (const dim of Object.values(dimensions)) total += dim.score;
  return Math.max(0, Math.min(100, Math.round(total)));
}
