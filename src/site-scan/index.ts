/**
 * Site-scan mode (Fase 3, Steps 1 + 3) — public surface.
 *
 * discovery -> section-aware sampling -> per-page Fase 1 scan -> honest
 * site-level aggregation (30/70 split, mean + spread, coverage gap, hybrid
 * AI-access reporting, estimate label). See ./aggregate.ts for the shared math.
 */

export {
  discover,
  safeOrigin,
  DISCOVERY_LIMITS,
  type DiscoveryResult,
  type DiscoverySource,
} from "./discovery.js";

export {
  sample,
  sectionOf,
  MAX_TOTAL_PAGES,
  PER_SECTION,
  ROOT_SECTION,
  type SamplingResult,
  type SectionSample,
} from "./sampling.js";

export {
  siteScan,
  aggregateSiteScore,
  type SiteScanResult,
  type SiteScanOptions,
  type PageScanResult,
} from "./orchestrator.js";

export {
  aggregate,
  type SiteScoreResult,
  type SiteScore,
  type SiteLevelScore,
  type PageLevelScore,
  type AnswerReadinessBetaAggregate,
  type BlockDistribution,
  type CoverageGap,
  type WorstPage,
  type SampledPage,
} from "./aggregate.js";
