/**
 * Answer-Structure proxy (beta) — SEPARATE, outside the 100-point core.
 *
 * Cheap structural detection only, NO LLM: FAQ blocks, interrogative headings,
 * question-then-answer definition patterns, TL;DR / summary blocks, answer
 * paragraphs near headings, and step lists. Reported as its own 0-100 sub-score
 * ("Answer-readiness (beta)"). Full answer-ability lives in the MCP server.
 */

import { hasType } from "./schema-extract.js";
import { SCHEMA_ANSWER_FRIENDLY } from "./constants.js";
import type { AnalysisContext } from "./context.js";
import type { AnswerReadinessBeta, Finding, Grade } from "./types.js";

const INTERROGATIVE =
  /\b(what|why|how|when|where|who|which|can|does|do|is|are|should|will)\b.*\?|.+\?\s*$/i;
const TLDR_RE = /\b(tl;?dr|in short|key takeaways?|summary|at a glance|quick answer)\b/i;

function gradeFor(score: number): Grade {
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

export function scoreAnswerReadiness(ctx: AnalysisContext): AnswerReadinessBeta {
  const findings: Finding[] = [];
  const signals: Record<string, unknown> = {};
  const root = ctx.parsed.root;

  const headings = root.querySelectorAll("h1, h2, h3, h4, h5, h6");
  const headingTexts = headings.map((h) => h.text.trim()).filter(Boolean);

  // 1. Interrogative headings (question-shaped).
  const questionHeadings = headingTexts.filter((t) => t.includes("?") || INTERROGATIVE.test(t));
  signals.questionHeadingCount = questionHeadings.length;

  // 2. FAQ schema / FAQ block.
  const faqSchema = hasType(ctx.schema.jsonLdTypes, SCHEMA_ANSWER_FRIENDLY);
  const faqBlock =
    root.querySelector('[class*="faq" i]') !== null ||
    root.querySelector('[id*="faq" i]') !== null ||
    root.querySelector('[itemtype*="FAQPage" i]') !== null;
  signals.faqSchema = faqSchema;
  signals.faqBlock = faqBlock;

  // 3. TL;DR / summary block.
  const tldr = TLDR_RE.test(ctx.parsed.visibleText.slice(0, 4000));
  signals.tldr = tldr;

  // 4. Answer paragraph near a heading: a heading immediately followed by a
  //    substantial paragraph (>= 15 words).
  let answerParas = 0;
  for (const h of headings) {
    let sib = h.nextElementSibling;
    // skip whitespace-only nodes
    while (sib && sib.text.trim().length === 0) sib = sib.nextElementSibling;
    if (sib && sib.rawTagName?.toLowerCase() === "p") {
      const wc = sib.text.trim().split(/\s+/).length;
      if (wc >= 15) answerParas++;
    }
  }
  signals.answerParagraphs = answerParas;

  // 5. Step lists (ordered lists, HowTo).
  const olCount = root.querySelectorAll("ol").length;
  const howto = hasType(ctx.schema.jsonLdTypes, ["HowTo"]);
  signals.orderedListCount = olCount;
  signals.howToSchema = howto;

  // --- Weighted proxy score (0-100, standalone) ---
  let score = 0;

  // Question headings: up to 30.
  if (questionHeadings.length >= 3) score += 30;
  else if (questionHeadings.length === 2) score += 22;
  else if (questionHeadings.length === 1) score += 12;

  // FAQ signals: up to 25.
  if (faqSchema) score += 20;
  if (faqBlock) score += 5;

  // TL;DR / summary: up to 15.
  if (tldr) score += 15;

  // Answer paragraphs near headings: up to 20.
  if (answerParas >= 4) score += 20;
  else if (answerParas >= 2) score += 13;
  else if (answerParas >= 1) score += 6;

  // Step lists: up to 10.
  if (howto) score += 10;
  else if (olCount >= 1) score += 6;

  score = Math.max(0, Math.min(100, score));

  // Findings.
  if (questionHeadings.length > 0) {
    findings.push({
      code: "answer.question_headings",
      message: `${questionHeadings.length} question-shaped heading(s) detected, which map well to AI answers.`,
      severity: "info",
      positive: true,
    });
  } else {
    findings.push({
      code: "answer.no_question_headings",
      message: "No question-shaped headings were found; framing sections as questions helps answer engines.",
      severity: "low",
      positive: false,
    });
  }
  if (faqSchema || faqBlock) {
    findings.push({
      code: "answer.faq",
      message: "FAQ structure detected (schema and/or markup).",
      severity: "info",
      positive: true,
    });
  }
  if (tldr) {
    findings.push({
      code: "answer.tldr",
      message: "A TL;DR / summary block was detected, which is easy for AI to lift.",
      severity: "info",
      positive: true,
    });
  }
  if (answerParas === 0) {
    findings.push({
      code: "answer.no_answer_paras",
      message: "No substantial answer paragraphs directly follow headings; lead with a direct answer under each heading.",
      severity: "low",
      positive: false,
    });
  }

  return {
    score,
    grade: gradeFor(score),
    signals,
    findings,
  };
}
