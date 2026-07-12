/**
 * Dimension 5 — Metadata & Identity / Provenance (weight 12).
 *
 * Checks: title + meta description, canonical, Open Graph / Twitter cards,
 * lang attribute, author/publisher signals (byline, Organization/Person schema,
 * sameAs), and published/modified dates. Entity clarity + provenance are trust
 * signals AI engines use for attribution and citation.
 */

import { DIMENSION_WEIGHTS, DIMENSION_LABELS } from "../types.js";
import { findNode } from "../schema-extract.js";
import type { AnalysisContext } from "../context.js";
import type { DimensionResult, Finding } from "../types.js";

const MAX = DIMENSION_WEIGHTS.metadataProvenance; // 12

function metaContent(
  root: AnalysisContext["parsed"]["root"],
  selector: string,
): string {
  const el = root.querySelector(selector);
  return (el?.getAttribute("content") ?? "").trim();
}

export function scoreMetadataProvenance(ctx: AnalysisContext): DimensionResult {
  const findings: Finding[] = [];
  const signals: Record<string, unknown> = {};
  const root = ctx.parsed.root;

  // --- Description (up to 2) ---
  const desc = metaContent(root, 'meta[name="description" i]');
  signals.metaDescription = desc || null;
  signals.metaDescriptionLength = desc.length;
  let descScore = 0;
  if (desc.length >= 50 && desc.length <= 320) {
    descScore = 2;
  } else if (desc.length > 0) {
    descScore = 1;
  } else {
    findings.push({
      code: "meta.no_description",
      message: "No meta description was found; add a concise summary of the page.",
      severity: "medium",
      positive: false,
    });
  }

  // --- Canonical (up to 2) ---
  const canonicalEl = root.querySelector('link[rel="canonical" i]');
  const canonical = (canonicalEl?.getAttribute("href") ?? "").trim();
  signals.canonical = canonical || null;
  let canonicalScore = 0;
  if (canonical) {
    canonicalScore = 2;
  } else {
    findings.push({
      code: "meta.no_canonical",
      message: "No canonical URL is declared; add one to consolidate signals for this page.",
      severity: "low",
      positive: false,
    });
  }

  // --- Open Graph / Twitter (up to 2) ---
  const ogTitle = metaContent(root, 'meta[property="og:title" i]');
  const ogDesc = metaContent(root, 'meta[property="og:description" i]');
  const ogType = metaContent(root, 'meta[property="og:type" i]');
  const twitterCard = metaContent(root, 'meta[name="twitter:card" i]');
  signals.openGraph = { ogTitle: !!ogTitle, ogDesc: !!ogDesc, ogType: ogType || null };
  signals.twitterCard = twitterCard || null;
  let socialScore = 0;
  if (ogTitle && ogDesc) socialScore += 1;
  if (twitterCard) socialScore += 1;
  if (socialScore === 0) {
    findings.push({
      code: "meta.no_social",
      message: "No Open Graph or Twitter Card metadata was found; these aid rich sharing and entity context.",
      severity: "low",
      positive: false,
    });
  }

  // --- lang attribute (up to 1) ---
  const htmlEl = root.querySelector("html");
  const lang = (htmlEl?.getAttribute("lang") ?? "").trim();
  signals.lang = lang || null;
  const langScore = lang ? 1 : 0;
  if (!lang) {
    findings.push({
      code: "meta.no_lang",
      message: "The <html> element has no lang attribute; declare the content language.",
      severity: "low",
      positive: false,
    });
  }

  // --- Author / publisher signals (up to 3) ---
  const orgNode = findNode(ctx.schema.jsonLdNodes, ["Organization", "LocalBusiness"]);
  const personNode = findNode(ctx.schema.jsonLdNodes, ["Person"]);
  const articleNode = findNode(ctx.schema.jsonLdNodes, [
    "Article",
    "BlogPosting",
    "NewsArticle",
  ]);
  const hasSchemaAuthor =
    !!personNode || (articleNode !== null && "author" in articleNode);
  const hasSchemaPublisher =
    !!orgNode || (articleNode !== null && "publisher" in articleNode);

  // HTML byline signals (best-effort).
  const bylineEl =
    root.querySelector('[rel="author" i]') ??
    root.querySelector('[class*="author" i]') ??
    root.querySelector('[itemprop="author" i]') ??
    root.querySelector('meta[name="author" i]');
  const hasByline = bylineEl !== null;

  signals.authorSignals = { hasSchemaAuthor, hasSchemaPublisher, hasByline };

  let authorScore = 0;
  if (hasSchemaPublisher) authorScore += 1;
  if (hasSchemaAuthor || hasByline) authorScore += 2;
  authorScore = Math.min(3, authorScore);
  if (authorScore === 0) {
    findings.push({
      code: "meta.no_author",
      message: "No author or publisher signals (byline, Organization/Person schema) were found; these are trust signals for AI attribution.",
      severity: "medium",
      positive: false,
    });
  } else {
    findings.push({
      code: "meta.author_present",
      message: "Author/publisher provenance signals are present.",
      severity: "info",
      positive: true,
    });
  }

  // --- Dates (up to 2) ---
  let hasDate = false;
  if (articleNode) {
    hasDate = "datePublished" in articleNode || "dateModified" in articleNode;
  }
  if (!hasDate) {
    const timeEl = root.querySelector("time[datetime]");
    const ogPublished = metaContent(root, 'meta[property="article:published_time" i]');
    hasDate = timeEl !== null || !!ogPublished;
  }
  signals.hasDate = hasDate;
  let dateScore = 0;
  if (hasDate) {
    dateScore = 2;
  } else {
    findings.push({
      code: "meta.no_date",
      message: "No published/modified date was detected; freshness signals help AI engines judge recency.",
      severity: "low",
      positive: false,
    });
  }

  const score = Math.max(
    0,
    Math.min(
      MAX,
      descScore + canonicalScore + socialScore + langScore + authorScore + dateScore,
    ),
  );

  return {
    id: "metadataProvenance",
    label: DIMENSION_LABELS.metadataProvenance,
    score,
    max: MAX,
    signals,
    findings,
  };
}
