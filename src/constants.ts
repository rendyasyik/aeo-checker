/**
 * Locked lists from the Phase 0 rubric (fase-0-brief-rubrik.md + decisions.md).
 * Do not silently change these; they are approved values.
 */

/**
 * AI crawler / agent user-agents we check for in robots.txt.
 * Locked list from the rubric (dimension 1). Order preserved for reporting.
 */
export const AI_BOTS: readonly string[] = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-User",
  "anthropic-ai",
  "Google-Extended",
  "PerplexityBot",
  "Perplexity-User",
  "Applebot-Extended",
  "CCBot",
  "Bytespider",
  "Amazonbot",
  "Meta-ExternalAgent",
  "DuckAssistBot",
  "cohere-ai",
  "Diffbot",
];

/**
 * Tier A schema.org types (high priority, heavy weight in the schema dimension).
 * Matched case-insensitively against JSON-LD @type values.
 */
export const SCHEMA_TIER_A: readonly string[] = [
  "Organization",
  "LocalBusiness",
  "Person",
  "Article",
  "BlogPosting",
  "NewsArticle",
  "FAQPage",
  "HowTo",
  "Product",
  "Offer",
  "AggregateRating",
  "Review",
  "BreadcrumbList",
  "WebSite",
  "WebPage",
  "QAPage",
];

/** Tier B schema.org types (bonus context). */
export const SCHEMA_TIER_B: readonly string[] = [
  "Event",
  "Recipe",
  "VideoObject",
  "ImageObject",
  "Course",
  "JobPosting",
  "SoftwareApplication",
  "Book",
  "Dataset",
  "SpecialAnnouncement",
  "SpeakableSpecification",
];

/** Answer-friendly schema types (bonus in schema dimension). */
export const SCHEMA_ANSWER_FRIENDLY: readonly string[] = [
  "FAQPage",
  "HowTo",
  "QAPage",
];

/** Content-entity schema types (Article family). */
export const SCHEMA_CONTENT_ENTITY: readonly string[] = [
  "Article",
  "BlogPosting",
  "NewsArticle",
];

/** A polite, identifiable default user-agent for our fetcher. */
export const DEFAULT_USER_AGENT =
  "aeo-checker/0.1 (+https://github.com/rendyasyik/aeo-checker; AI-readiness audit bot)";

/** Default fetch timeout in milliseconds. */
export const DEFAULT_TIMEOUT_MS = 15000;
