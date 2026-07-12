/**
 * Shared, stable result types for the AEO / AI-readiness engine.
 *
 * These types form the public contract consumed by the web tool (Cloudflare
 * Worker) and the MCP server. Keep them stable and additive.
 */

/** Honest classification of what an AI crawler can actually see for a URL. */
export type BlockStatus = "OK" | "HARD_BLOCK" | "SOFT_BLOCK";

/** The six core scoring dimensions (each with a locked weight). */
export type DimensionId =
  | "aiCrawlerAccess"
  | "contentExtractability"
  | "structuredData"
  | "semanticStructure"
  | "metadataProvenance"
  | "llmsTxt";

/** Letter grade derived deterministically from the 0-100 total. */
export type Grade = "A" | "B" | "C" | "D" | "F";

/** Severity used to sort and communicate findings. */
export type Severity = "critical" | "high" | "medium" | "low" | "info";

/** A single human-readable finding within a dimension. */
export interface Finding {
  /** Machine-stable code, e.g. "robots.gptbot_blocked". */
  code: string;
  /** English, user-facing message. */
  message: string;
  severity: Severity;
  /** true = something good detected; false = a problem/gap. */
  positive: boolean;
}

/** Result of scoring one dimension. */
export interface DimensionResult {
  id: DimensionId;
  /** English label for display. */
  label: string;
  /** Points earned in this dimension. */
  score: number;
  /** Maximum points this dimension can contribute (its locked weight). */
  max: number;
  /** Raw detected signals for transparency (JSON-serializable). */
  signals: Record<string, unknown>;
  /** Human-readable findings. */
  findings: Finding[];
}

/** One actionable fix, ordered impact-first. */
export interface Fix {
  /** Machine-stable code. */
  code: string;
  /** English, imperative recommendation. */
  message: string;
  /** Which dimension this fix would improve. */
  dimension: DimensionId | "answerReadinessBeta";
  /** Estimated point impact if resolved (approximate). */
  impact: number;
  severity: Severity;
}

/** Separate, out-of-100 structural answer-readiness proxy (beta, no LLM). */
export interface AnswerReadinessBeta {
  /** 0-100 structural proxy score. NOT part of the core 100. */
  score: number;
  /** Letter grade for the beta sub-score. */
  grade: Grade;
  signals: Record<string, unknown>;
  findings: Finding[];
}

/** Block-detection report. */
export interface BlockReport {
  status: BlockStatus;
  httpStatus: number | null;
  /** Machine-stable reason code, e.g. "http_403", "js_only_shell". */
  reason: string;
  /** English explanation of the classification. */
  detail: string;
}

/** Full, stable report object. Reusable by web tool + MCP. */
export interface AeoReport {
  url: string;
  /** URL after following redirects (final response URL). */
  finalUrl: string;
  fetchedAt: string;
  /** 0-100 core total. */
  total: number;
  grade: Grade;
  block: BlockReport;
  dimensions: Record<DimensionId, DimensionResult>;
  /** Ordered impact-first. */
  fixes: Fix[];
  /** Separate beta sub-score, outside the 100-point core. */
  answerReadinessBeta: AnswerReadinessBeta;
  /** Non-fatal notes about the analysis itself (e.g. best-effort limits). */
  notes: string[];
}

/** Locked weight per dimension. Sums to 100. */
export const DIMENSION_WEIGHTS: Record<DimensionId, number> = {
  aiCrawlerAccess: 22,
  contentExtractability: 22,
  structuredData: 20,
  semanticStructure: 16,
  metadataProvenance: 12,
  llmsTxt: 8,
};

export const DIMENSION_LABELS: Record<DimensionId, string> = {
  aiCrawlerAccess: "AI Crawler Access",
  contentExtractability: "Content Extractability without JS",
  structuredData: "Structured Data / Schema.org",
  semanticStructure: "Semantic Content Structure",
  metadataProvenance: "Metadata & Identity / Provenance",
  llmsTxt: "llms.txt discoverability",
};
