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

/**
 * Structural answer-structure signals, surfaced verbatim from the deterministic
 * answer-readiness (beta) detector. These are RAW STRUCTURAL SIGNALS only:
 * counts and boolean presence flags for FAQ structure, question-shaped
 * headings, answer paragraphs, TL;DR/summary blocks, and step lists.
 *
 * IMPORTANT: the engine does NOT judge the QUALITY, correctness, or usefulness
 * of any answer. It only reports what structural patterns exist in the raw
 * HTML. Grading answer quality is the job of the host LLM (this is the point of
 * the MCP surface). Do not treat these numbers as a quality verdict.
 */
export interface AnswerStructure {
  /** FAQ detected via answer-friendly JSON-LD (e.g. FAQPage/QAPage). */
  faqSchema: boolean;
  /** FAQ detected via class/id/itemtype markup fingerprints. */
  faqBlock: boolean;
  /** Count of question-shaped (interrogative or "?"-terminated) headings. */
  questionHeadingCount: number;
  /** Count of substantial (>=15-word) paragraphs directly following a heading. */
  answerParagraphCount: number;
  /** A TL;DR / summary / key-takeaways block was detected near the top. */
  tldr: boolean;
  /** Count of ordered lists (<ol>), a proxy for step lists. */
  orderedListCount: number;
  /** HowTo step structure detected via JSON-LD. */
  howToSchema: boolean;
}

/**
 * Raw extracted page content + structural signals, surfaced ONLY when
 * `analyzeUrl(..., { includeExtractedContent: true })` is set. Off by default so
 * the web tool (Cloudflare Worker) contract and payload size are unchanged.
 *
 * This is the substrate for the MCP server: it hands the host LLM the readable
 * text an AI crawler actually sees (no JS render) plus deterministic structural
 * signals, so the host LLM can judge answer-ability. The engine itself makes no
 * quality judgement here.
 */
export interface ExtractedContent {
  /**
   * Readable text an AI crawler sees from the raw HTML (scripts/styles removed,
   * whitespace collapsed). Reuses the same extraction the Content Extractability
   * dimension is scored on. May be capped; see `truncated` / `originalLength`.
   */
  mainText: string;
  /** true if `mainText` was cut to `MAX_EXTRACTED_CONTENT_CHARS`. */
  truncated: boolean;
  /** Original readable-text length in characters, before any capping. */
  originalLength: number;
  /**
   * Word count of the readable text (pre-cap; from the parser's own count).
   */
  wordCount: number;
  /**
   * true when block status is not OK (HARD_BLOCK / SOFT_BLOCK). When set, the
   * text reflects only what was visible in the raw HTML (often empty), and the
   * structural signals should be read with that caveat.
   */
  blocked: boolean;
  /** Deterministic structural signals; NOT a quality judgement (see above). */
  answerStructure: AnswerStructure;
}

/** Hard cap on surfaced extracted text, to protect host LLM context budget. */
export const MAX_EXTRACTED_CONTENT_CHARS = 20000;

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
  /**
   * Raw extracted content + structural answer signals for the MCP surface.
   * Present ONLY when analysis was run with `includeExtractedContent: true`;
   * absent (undefined) otherwise, so the default report contract is unchanged.
   */
  extractedContent?: ExtractedContent;
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
