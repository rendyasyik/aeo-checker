/**
 * Dimension 3 — Structured Data / Schema.org (weight 20).
 *
 * JSON-LD is the primary source (parsed). Microdata/RDFa are best-effort
 * (presence + types only) — a documented limitation.
 *
 * Score logic (from rubric, with caps):
 *   base (valid JSON-LD present)                    up to 6
 *   relevance (content-entity type matches page)    up to 4
 *   entity completeness (Org/Person + sameAs)       up to 5
 *   BreadcrumbList                                   +2
 *   WebSite                                          +1
 *   answer-friendly bonus (FAQPage/HowTo/QAPage)     +2 (capped)
 * Total capped at 20.
 */

import { DIMENSION_WEIGHTS, DIMENSION_LABELS } from "../types.js";
import {
  SCHEMA_TIER_A,
  SCHEMA_TIER_B,
  SCHEMA_ANSWER_FRIENDLY,
  SCHEMA_CONTENT_ENTITY,
} from "../constants.js";
import { matchedTypes, hasType, findNode } from "../schema-extract.js";
import type { AnalysisContext } from "../context.js";
import type { DimensionResult, Finding } from "../types.js";

const MAX = DIMENSION_WEIGHTS.structuredData; // 20

function hasSameAs(node: Record<string, unknown> | null): boolean {
  if (!node) return false;
  const s = node["sameAs"];
  return typeof s === "string" || (Array.isArray(s) && s.length > 0);
}

export function scoreStructuredData(ctx: AnalysisContext): DimensionResult {
  const findings: Finding[] = [];
  const signals: Record<string, unknown> = {};
  const s = ctx.schema;

  const tierA = matchedTypes(s.jsonLdTypes, SCHEMA_TIER_A);
  const tierB = matchedTypes(s.jsonLdTypes, SCHEMA_TIER_B);

  signals.jsonLdBlockCount = s.jsonLdBlockCount;
  signals.jsonLdInvalidCount = s.jsonLdInvalidCount;
  signals.jsonLdTypes = s.jsonLdTypes;
  signals.tierAMatched = tierA;
  signals.tierBMatched = tierB;
  signals.microdataTypes = s.microdataTypes;
  signals.rdfaTypes = s.rdfaTypes;

  if (s.jsonLdInvalidCount > 0) {
    findings.push({
      code: "schema.invalid_jsonld",
      message: `${s.jsonLdInvalidCount} JSON-LD block(s) could not be parsed and are being ignored by machines.`,
      severity: "medium",
      positive: false,
    });
  }

  // No structured data at all.
  if (!s.hasAny) {
    findings.push({
      code: "schema.none",
      message:
        "No structured data (JSON-LD, microdata, or RDFa) was detected. AI engines get no explicit entities or facts.",
      severity: "high",
      positive: false,
    });
    return {
      id: "structuredData",
      label: DIMENSION_LABELS.structuredData,
      score: 0,
      max: MAX,
      signals,
      findings,
    };
  }

  let score = 0;
  const validJsonLd = s.jsonLdBlockCount - s.jsonLdInvalidCount > 0 && s.jsonLdTypes.length > 0;

  // base
  if (validJsonLd) {
    score += 6;
    findings.push({
      code: "schema.jsonld_present",
      message: `Valid JSON-LD is present with type(s): ${s.jsonLdTypes.slice(0, 8).join(", ")}.`,
      severity: "info",
      positive: true,
    });
  } else if (s.hasAny) {
    // Only microdata/RDFa detected (best-effort).
    score += 2;
    findings.push({
      code: "schema.microdata_only",
      message: `Only microdata/RDFa markup was detected (best-effort): ${[...s.microdataTypes, ...s.rdfaTypes].slice(0, 6).join(", ")}. JSON-LD is preferred for AI engines.`,
      severity: "low",
      positive: true,
    });
  }

  // relevance: content-entity type present
  if (hasType(s.jsonLdTypes, SCHEMA_CONTENT_ENTITY)) {
    score += 4;
    findings.push({
      code: "schema.content_entity",
      message: "An Article/BlogPosting/NewsArticle entity describes the page content.",
      severity: "info",
      positive: true,
    });
  } else if (hasType(s.jsonLdTypes, ["Product", "QAPage", "FAQPage", "HowTo", "Recipe", "Event"])) {
    score += 3;
  }

  // entity completeness: Organization/Person + sameAs
  const orgNode = findNode(s.jsonLdNodes, ["Organization", "LocalBusiness"]);
  const personNode = findNode(s.jsonLdNodes, ["Person"]);
  let entityScore = 0;
  if (orgNode) entityScore += 2;
  if (personNode) entityScore += 1;
  if (hasSameAs(orgNode) || hasSameAs(personNode)) {
    entityScore += 2;
    findings.push({
      code: "schema.sameas",
      message: "A sameAs property links the entity to authoritative profiles (helps disambiguation).",
      severity: "info",
      positive: true,
    });
  } else if (orgNode || personNode) {
    findings.push({
      code: "schema.no_sameas",
      message: "An Organization/Person entity is present but has no sameAs links for entity disambiguation.",
      severity: "low",
      positive: false,
    });
  }
  if (!orgNode && !personNode) {
    findings.push({
      code: "schema.no_identity",
      message: "No Organization or Person entity was found; publisher/author identity is unclear to AI engines.",
      severity: "medium",
      positive: false,
    });
  }
  score += Math.min(5, entityScore);

  // BreadcrumbList
  if (hasType(s.jsonLdTypes, ["BreadcrumbList"])) {
    score += 2;
    findings.push({
      code: "schema.breadcrumb",
      message: "BreadcrumbList markup provides site-structure context.",
      severity: "info",
      positive: true,
    });
  }

  // WebSite
  if (hasType(s.jsonLdTypes, ["WebSite"])) {
    score += 1;
  }

  // answer-friendly bonus (capped)
  const answerFriendly = matchedTypes(s.jsonLdTypes, SCHEMA_ANSWER_FRIENDLY);
  if (answerFriendly.length > 0) {
    score += 2;
    findings.push({
      code: "schema.answer_friendly",
      message: `Answer-friendly schema present (${answerFriendly.join(", ")}), which maps directly to AI answers.`,
      severity: "info",
      positive: true,
    });
  }

  if (tierB.length > 0 && tierA.length > 0) {
    score += 1; // small context bonus
  }

  score = Math.max(0, Math.min(MAX, score));

  return {
    id: "structuredData",
    label: DIMENSION_LABELS.structuredData,
    score,
    max: MAX,
    signals,
    findings,
  };
}
