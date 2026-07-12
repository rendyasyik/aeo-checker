/**
 * Site-scan SECTION-AWARE SAMPLING (Fase 3, Step 1).
 *
 * Deterministic: identical candidate input -> identical sample output, stable
 * order. No randomness. Given discovered same-origin candidate URLs, cluster
 * them by SECTION and pick a small, representative, cost-bounded sample.
 *
 * SECTION definition:
 *   - The first path segment. `/blog/x` -> "blog", `/news/y` -> "news".
 *   - Root-level URLs (path "/" or a single segment with no sub-path, e.g.
 *     "/about") belong to the special section "root".
 *
 * Selection rules (all deterministic, documented for reproducibility):
 *   1. The HOMEPAGE (origin + "/") is ALWAYS included as a mandatory sample and
 *      is NEVER subject to the cost cap below.
 *   2. Within each section, URLs are sorted lexicographically and the FIRST
 *      `PER_SECTION` (=2) are taken. ("2 first lexicographic" — simple and
 *      reproducible; chosen over first+middle for clarity.)
 *   3. COST/ABUSE FENCE: total sampled pages must not exceed MAX_TOTAL_PAGES.
 *      The homepage is reserved first and does not count against section
 *      truncation. If (#sections * PER_SECTION + homepage) would exceed the cap,
 *      sections are PRIORITIZED deterministically: sort sections by URL count
 *      (desc), then section name (asc) as tie-break, and take PER_SECTION from
 *      the top until the remaining budget is exhausted. Sections that could not
 *      fit are reported in `truncatedSections` for honesty/transparency.
 */

/** Max pages we will ever fetch+scan for one site. Tune here. */
export const MAX_TOTAL_PAGES = 15;

/** Max samples taken from a single section. Tune here. */
export const PER_SECTION = 2;

/** Special section name for root-level URLs. */
export const ROOT_SECTION = "root";

export interface SectionSample {
  /** Section key (first path segment, or "root"). */
  section: string;
  /** URLs chosen from this section (<= PER_SECTION), lexicographically first. */
  urls: string[];
  /** Total same-origin candidates available in this section (pre-cap). */
  available: number;
}

export interface SamplingResult {
  /** Flat, deduped list of URLs to scan (homepage first, then by section). */
  sampled: string[];
  /** Per-section breakdown of what was chosen (only sections that contributed). */
  sections: SectionSample[];
  /**
   * Sections that were dropped entirely (or partially) by the cost cap, for
   * transparency. Each entry notes the section and how many URLs it had.
   */
  truncatedSections: Array<{ section: string; available: number }>;
  /** The homepage URL that was force-included. */
  homepage: string;
}

/** Derive the section key for a URL relative to its origin. */
export function sectionOf(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return ROOT_SECTION;
  }
  // Normalize: strip leading/trailing slashes, split.
  const segments = path.split("/").filter((s) => s.length > 0);
  if (segments.length === 0) return ROOT_SECTION; // "/"
  if (segments.length === 1) return ROOT_SECTION; // "/about" -> root-level page
  const first = segments[0];
  return first && first.length > 0 ? first.toLowerCase() : ROOT_SECTION;
}

/** True if `url` is the site homepage (origin + "/", no meaningful path). */
function isHomepage(url: string, origin: string): boolean {
  try {
    const u = new URL(url);
    if (u.origin !== origin) return false;
    const p = u.pathname === "" ? "/" : u.pathname;
    return p === "/" && u.search === "" && u.hash === "";
  } catch {
    return false;
  }
}

/**
 * Section-aware, deterministic, cost-bounded sampling.
 *
 * @param candidates same-origin candidate URLs (as produced by discovery)
 * @param origin     the site origin (scheme + host [+ port])
 */
export function sample(candidates: string[], origin: string): SamplingResult {
  const homepage = `${origin}/`;

  // Dedupe candidates, preserving determinism via later lexicographic sort.
  const uniq = Array.from(new Set(candidates));

  // Cluster by section, excluding the homepage (it is force-included).
  const bySection = new Map<string, string[]>();
  for (const url of uniq) {
    if (isHomepage(url, origin)) continue;
    const key = sectionOf(url);
    const arr = bySection.get(key);
    if (arr) arr.push(url);
    else bySection.set(key, [url]);
  }

  // Deterministic section ordering for the OUTPUT breakdown: by name asc.
  // Deterministic section ordering for PRIORITIZATION under the cap: by URL
  // count desc, then name asc.
  const sectionEntries = Array.from(bySection.entries()).map(([section, urls]) => ({
    section,
    urls: urls.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  }));

  const priorityOrder = sectionEntries
    .slice()
    .sort((a, b) => {
      if (b.urls.length !== a.urls.length) return b.urls.length - a.urls.length;
      return a.section < b.section ? -1 : a.section > b.section ? 1 : 0;
    });

  // Homepage is reserved first and is exempt from the cap.
  const sampled: string[] = [homepage];
  let budget = MAX_TOTAL_PAGES - 1; // remaining slots for section samples
  if (budget < 0) budget = 0;

  const chosenSections: SectionSample[] = [];
  const truncatedSections: Array<{ section: string; available: number }> = [];

  for (const entry of priorityOrder) {
    const available = entry.urls.length;
    if (budget <= 0) {
      truncatedSections.push({ section: entry.section, available });
      continue;
    }
    const take = Math.min(PER_SECTION, available, budget);
    const picked = entry.urls.slice(0, take);
    for (const u of picked) sampled.push(u);
    budget -= take;
    chosenSections.push({ section: entry.section, urls: picked, available });
    // If the section had more than we could take, note the shortfall honestly.
    if (take < Math.min(PER_SECTION, available)) {
      truncatedSections.push({ section: entry.section, available });
    }
  }

  // Present the chosen-section breakdown in a stable, name-sorted order.
  chosenSections.sort((a, b) =>
    a.section < b.section ? -1 : a.section > b.section ? 1 : 0,
  );
  truncatedSections.sort((a, b) =>
    a.section < b.section ? -1 : a.section > b.section ? 1 : 0,
  );

  return {
    sampled: Array.from(new Set(sampled)),
    sections: chosenSections,
    truncatedSections,
    homepage,
  };
}
