/**
 * Site-scan mode (Fase 3, Step 1) — public surface.
 *
 * discovery -> section-aware sampling -> per-page Fase 1 scan. Aggregation of a
 * single site-level score is intentionally deferred (see orchestrator stub).
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
