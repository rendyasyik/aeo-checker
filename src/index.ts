/**
 * aeo-checker — public entry point.
 *
 * Runtime-agnostic: uses only global fetch + Web-standard APIs. The same
 * engine runs in a Cloudflare Worker (web tool) and in Node (MCP server).
 */

import { fetchRaw, originUrl, type FetchOptions } from "./fetcher.js";
import { parseHtml } from "./html.js";
import { detectBlock } from "./block-detect.js";
import { parseRobots, type ParsedRobots } from "./robots.js";
import { extractSchema } from "./schema-extract.js";
import { fetchLlmsTxt } from "./llms-fetch.js";
import { scoreAiCrawlerAccess } from "./dimensions/ai-crawler-access.js";
import { scoreContentExtractability } from "./dimensions/content-extractability.js";
import { scoreStructuredData } from "./dimensions/structured-data.js";
import { scoreSemanticStructure } from "./dimensions/semantic-structure.js";
import { scoreMetadataProvenance } from "./dimensions/metadata-provenance.js";
import { scoreLlmsTxt } from "./dimensions/llms-txt.js";
import { scoreAnswerReadiness } from "./answer-readiness.js";
import { buildFixes, computeTotal, gradeForTotal } from "./scoring.js";
import type { AnalysisContext, LlmsTxtResult } from "./context.js";
import type {
  AeoReport,
  AnswerStructure,
  DimensionId,
  DimensionResult,
  ExtractedContent,
} from "./types.js";
import { MAX_EXTRACTED_CONTENT_CHARS } from "./types.js";

export * from "./types.js";
export type { AnalysisContext, LlmsTxtResult } from "./context.js";
export { fetchRaw } from "./fetcher.js";
export { parseHtml } from "./html.js";
export { detectBlock } from "./block-detect.js";
export { parseRobots, isAllowed } from "./robots.js";
export { extractSchema } from "./schema-extract.js";
export { checkWellFormed } from "./llms-fetch.js";
export { validateUrlForFetch, type SsrfCheck } from "./ssrf.js";

// Site-scan mode (Fase 3, Step 1): discovery + section-aware sampling +
// orchestrator. Site-level score aggregation is intentionally deferred.
export * from "./site-scan/index.js";

export interface AnalyzeOptions extends FetchOptions {
  /** Skip network fetches for robots.txt / llms.txt (for offline analysis). */
  skipAuxiliaryFetches?: boolean;
  /**
   * When true, attach `extractedContent` (readable text an AI crawler sees +
   * deterministic structural answer signals) to the report. Default false so
   * the web tool / Worker contract and payload size are unchanged. Intended for
   * the MCP server, where the host LLM judges answer-ability.
   */
  includeExtractedContent?: boolean;
}

/**
 * Build the MCP substrate object by SURFACING already-computed values: the
 * parser's readable text (same extraction the Content Extractability dimension
 * scores) and the answer-readiness (beta) structural signals. Nothing is
 * recomputed or re-derived with different logic, and no quality judgement is
 * made here. Deterministic.
 */
function buildExtractedContent(
  ctx: AnalysisContext,
  answerSignals: Record<string, unknown>,
): ExtractedContent {
  const blocked = ctx.block.status !== "OK";
  const full = ctx.parsed.visibleText;
  const originalLength = full.length;
  const truncated = originalLength > MAX_EXTRACTED_CONTENT_CHARS;
  const mainText = truncated
    ? full.slice(0, MAX_EXTRACTED_CONTENT_CHARS)
    : full;

  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const bool = (v: unknown): boolean => v === true;

  const answerStructure: AnswerStructure = {
    faqSchema: bool(answerSignals.faqSchema),
    faqBlock: bool(answerSignals.faqBlock),
    questionHeadingCount: num(answerSignals.questionHeadingCount),
    answerParagraphCount: num(answerSignals.answerParagraphs),
    tldr: bool(answerSignals.tldr),
    orderedListCount: num(answerSignals.orderedListCount),
    howToSchema: bool(answerSignals.howToSchema),
  };

  return {
    mainText,
    truncated,
    originalLength,
    wordCount: ctx.parsed.wordCount,
    blocked,
    answerStructure,
  };
}

/**
 * Analyze already-fetched HTML plus pre-resolved auxiliary inputs. Pure and
 * deterministic — used directly by tests with fixtures (no network).
 */
export function analyzeContext(
  ctx: AnalysisContext,
  opts: { includeExtractedContent?: boolean } = {},
): AeoReport {
  const dimensions: Record<DimensionId, DimensionResult> = {
    aiCrawlerAccess: scoreAiCrawlerAccess(ctx),
    contentExtractability: scoreContentExtractability(ctx),
    structuredData: scoreStructuredData(ctx),
    semanticStructure: scoreSemanticStructure(ctx),
    metadataProvenance: scoreMetadataProvenance(ctx),
    llmsTxt: scoreLlmsTxt(ctx),
  };

  const notes: string[] = [];
  if (ctx.schema.microdataTypes.length > 0 || ctx.schema.rdfaTypes.length > 0) {
    notes.push(
      "Microdata/RDFa detection is best-effort (presence + type only); JSON-LD is fully parsed.",
    );
  }

  // When the page is blocked, core content-based dimensions cannot be trusted;
  // report honestly but still return the (low) deterministic scores.
  if (ctx.block.status !== "OK") {
    notes.push(
      `Block status ${ctx.block.status}: ${ctx.block.detail} Content-based dimension scores reflect only what was visible in the raw HTML.`,
    );
  }

  const total = computeTotal(dimensions);
  const answerReadinessBeta = scoreAnswerReadiness(ctx);
  const fixes = buildFixes(dimensions);

  const report: AeoReport = {
    url: ctx.url,
    finalUrl: ctx.finalUrl,
    fetchedAt: new Date().toISOString(),
    total,
    grade: gradeForTotal(total),
    block: ctx.block,
    dimensions,
    fixes,
    answerReadinessBeta,
    notes,
  };

  if (opts.includeExtractedContent) {
    // Surface-only: reuse the already-computed answer-readiness signals so the
    // MCP substrate never diverges from the scored beta detector.
    report.extractedContent = buildExtractedContent(
      ctx,
      answerReadinessBeta.signals,
    );
  }

  return report;
}

/** Fetch a URL (raw HTML + robots.txt + llms.txt) and produce a full report. */
export async function analyzeUrl(
  url: string,
  opts: AnalyzeOptions = {},
): Promise<AeoReport> {
  const page = await fetchRaw(url, opts);
  const parsed = parseHtml(page.body);
  const block = detectBlock(page, parsed);
  const schema = extractSchema(parsed.root);

  let robots: ParsedRobots | null = null;
  let robotsFetched = false;
  let llmsTxt: LlmsTxtResult = {
    present: false,
    status: null,
    wellFormed: false,
    detail: "not fetched",
    fullPresent: false,
    fullStatus: null,
  };

  if (!opts.skipAuxiliaryFetches) {
    try {
      const robotsRes = await fetchRaw(originUrl(url, "/robots.txt"), opts);
      if (robotsRes.status === 200 && robotsRes.body.trim().length > 0) {
        robots = parseRobots(robotsRes.body);
        robotsFetched = true;
      }
    } catch {
      // treat as absent
    }
    llmsTxt = await fetchLlmsTxt(url, opts);
  }

  let path = "/";
  try {
    path = new URL(page.finalUrl || url).pathname || "/";
  } catch {
    path = "/";
  }

  const ctx: AnalysisContext = {
    url,
    finalUrl: page.finalUrl || url,
    path,
    page,
    parsed,
    block,
    robots,
    robotsFetched,
    schema,
    llmsTxt,
  };

  return analyzeContext(ctx, {
    includeExtractedContent: opts.includeExtractedContent,
  });
}
