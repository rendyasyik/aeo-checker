/**
 * Site-scan DISCOVERY (Fase 3, Step 1).
 *
 * Runtime-agnostic URL discovery for a single origin. Uses the same injected
 * `fetchImpl` surface as the rest of the engine (see `FetchOptions`) so it runs
 * unchanged in the Cloudflare Worker (guarded fetch) and in Node (MCP).
 *
 * Strategy, in order:
 *   1. robots.txt  -> read declared `Sitemap:` lines (reuses `parseRobots`).
 *   2. sitemap(s)  -> fetch declared sitemaps (or fallback /sitemap.xml),
 *                     supporting <sitemapindex> recursion with hard caps.
 *   3. nav-fallback-> if no sitemap at all, fetch the homepage and extract
 *                     same-origin <a href> links, one level deep.
 *
 * Every URL considered is SSRF-validated before it is fetched, and every
 * collected candidate is filtered to the SAME ORIGIN as the target. URLs that
 * fail the SSRF guard are dropped (counted), never thrown.
 *
 * This module STOPS at candidate discovery — it does not sample or scan.
 */

import { fetchRaw, originUrl, type FetchOptions } from "../fetcher.js";
import { parseHtml } from "../html.js";
import { parseRobots } from "../robots.js";
import { validateUrlForFetch } from "../ssrf.js";

/** Where the candidate URLs came from. */
export type DiscoverySource =
  | "sitemap"
  | "sitemap-index"
  | "nav-fallback"
  | "none";

/** Hard caps on discovery work, exported so callers/tests can reason about them. */
export const DISCOVERY_LIMITS = {
  /** Max depth of <sitemapindex> recursion (index -> child -> ... ). */
  MAX_SITEMAP_DEPTH: 2,
  /** Absolute cap on total <loc> URLs parsed across all sitemaps. */
  MAX_SITEMAP_URLS: 2000,
  /** Cap on same-origin links harvested from the homepage in nav-fallback. */
  MAX_NAV_LINKS: 200,
} as const;

export interface DiscoveryResult {
  /** Origin the scan is rooted at (scheme + host [+ port]). */
  origin: string;
  /** Same-origin candidate URLs (deduped, SSRF-passed). Includes the homepage. */
  candidates: string[];
  /** How the bulk of candidates were found. */
  source: DiscoverySource;
  /** robots.txt existed and returned 200 with content. */
  robotsFound: boolean;
  /** At least one sitemap returned 200 with parseable content. */
  sitemapFound: boolean;
  /** Sitemap URLs declared in robots.txt (or the fallback probe). */
  declaredSitemaps: string[];
  /** How many candidate/child URLs were dropped by the SSRF guard. */
  droppedBySsrf: number;
  /** Count of raw candidates found before dedupe/cap (for transparency). */
  found: number;
}

/** Compute the origin of a URL, or null if it is unparseable. */
export function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** True if `url` is http/https AND shares `origin` AND passes the SSRF guard. */
function acceptSameOrigin(url: string, origin: string): boolean {
  if (safeOrigin(url) !== origin) return false;
  return validateUrlForFetch(url).ok;
}

/** Extract <loc> values from a sitemap or sitemap-index XML body. */
function extractLocs(xml: string): string[] {
  const out: string[] = [];
  const re = /<loc>\s*([^<\s][^<]*?)\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const raw = m[1];
    if (raw) out.push(decodeXmlEntities(raw.trim()));
  }
  return out;
}

/** Is this XML a <sitemapindex> (list of child sitemaps) rather than a urlset? */
function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

/** Minimal XML entity decode for URLs in <loc> (& and friends). */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

interface SitemapCrawlState {
  origin: string;
  opts: FetchOptions;
  /** Accumulated same-origin page URLs. */
  urls: string[];
  /** Guard against re-fetching the same sitemap URL (loops). */
  visited: Set<string>;
  droppedBySsrf: number;
  /** True once any sitemap fetch parsed successfully. */
  anyParsed: boolean;
}

/**
 * Recursively fetch a sitemap (or sitemap-index), collecting same-origin page
 * URLs. Bounded by MAX_SITEMAP_DEPTH and MAX_SITEMAP_URLS.
 */
async function crawlSitemap(
  sitemapUrl: string,
  depth: number,
  state: SitemapCrawlState,
): Promise<void> {
  if (state.urls.length >= DISCOVERY_LIMITS.MAX_SITEMAP_URLS) return;
  if (depth > DISCOVERY_LIMITS.MAX_SITEMAP_DEPTH) return;
  if (state.visited.has(sitemapUrl)) return;
  state.visited.add(sitemapUrl);

  // The sitemap URL itself must pass the SSRF guard before we fetch it.
  if (!validateUrlForFetch(sitemapUrl).ok) {
    state.droppedBySsrf += 1;
    return;
  }

  let body = "";
  try {
    const res = await fetchRaw(sitemapUrl, state.opts);
    if (res.status !== 200 || !res.body.trim()) return;
    body = res.body;
  } catch {
    return;
  }

  if (isSitemapIndex(body)) {
    // Child sitemaps: recurse (bounded by depth).
    const children = extractLocs(body);
    for (const child of children) {
      if (state.urls.length >= DISCOVERY_LIMITS.MAX_SITEMAP_URLS) return;
      // Only follow same-origin child sitemaps that pass SSRF.
      if (safeOrigin(child) !== state.origin) continue;
      if (!validateUrlForFetch(child).ok) {
        state.droppedBySsrf += 1;
        continue;
      }
      await crawlSitemap(child, depth + 1, state);
    }
    state.anyParsed = true;
    return;
  }

  // urlset: collect page <loc>s.
  const locs = extractLocs(body);
  if (locs.length > 0) state.anyParsed = true;
  for (const loc of locs) {
    if (state.urls.length >= DISCOVERY_LIMITS.MAX_SITEMAP_URLS) break;
    if (safeOrigin(loc) !== state.origin) continue;
    if (!validateUrlForFetch(loc).ok) {
      state.droppedBySsrf += 1;
      continue;
    }
    state.urls.push(loc);
  }
}

/** Extract same-origin <a href> links from homepage HTML, one level. */
function extractInternalLinks(
  html: string,
  pageUrl: string,
  origin: string,
): { links: string[]; dropped: number } {
  const parsed = parseHtml(html);
  const anchors = parsed.root.querySelectorAll("a");
  const links: string[] = [];
  let dropped = 0;
  for (const a of anchors) {
    const href = a.getAttribute("href");
    if (!href) continue;
    const trimmed = href.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (/^(mailto:|tel:|javascript:|data:)/i.test(trimmed)) continue;
    let abs: string;
    try {
      abs = new URL(trimmed, pageUrl).toString();
    } catch {
      continue;
    }
    if (safeOrigin(abs) !== origin) continue;
    if (!validateUrlForFetch(abs).ok) {
      dropped += 1;
      continue;
    }
    links.push(abs);
    if (links.length >= DISCOVERY_LIMITS.MAX_NAV_LINKS) break;
  }
  return { links, dropped };
}

/** Dedupe while preserving first-seen order. */
function dedupe(urls: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const u of urls) {
    if (seen.has(u)) continue;
    seen.add(u);
    out.push(u);
  }
  return out;
}

/**
 * Discover same-origin candidate URLs for a site starting at `target`.
 *
 * The homepage (origin + "/") is always included as a candidate. The `source`
 * reflects where the BULK of candidates came from.
 */
export async function discover(
  target: string,
  opts: FetchOptions = {},
): Promise<DiscoveryResult> {
  const origin = safeOrigin(target);
  if (origin === null) {
    // Unparseable target — return an empty, honest result.
    return {
      origin: target,
      candidates: [],
      source: "none",
      robotsFound: false,
      sitemapFound: false,
      declaredSitemaps: [],
      droppedBySsrf: 0,
      found: 0,
    };
  }

  const homepage = `${origin}/`;
  let droppedBySsrf = 0;

  // --- Step 1: robots.txt -> declared sitemaps -------------------------------
  let robotsFound = false;
  let declaredSitemaps: string[] = [];
  const robotsUrl = originUrl(target, "/robots.txt");
  if (validateUrlForFetch(robotsUrl).ok) {
    try {
      const res = await fetchRaw(robotsUrl, opts);
      if (res.status === 200 && res.body.trim().length > 0) {
        robotsFound = true;
        const parsed = parseRobots(res.body);
        declaredSitemaps = parsed.sitemaps.slice();
      }
    } catch {
      // treat as absent
    }
  } else {
    droppedBySsrf += 1;
  }

  // --- Step 2: sitemap(s) ----------------------------------------------------
  // Use declared sitemaps if any; else probe the conventional /sitemap.xml.
  const sitemapSeeds =
    declaredSitemaps.length > 0
      ? declaredSitemaps
      : [originUrl(target, "/sitemap.xml")];

  const state: SitemapCrawlState = {
    origin,
    opts,
    urls: [],
    visited: new Set<string>(),
    droppedBySsrf: 0,
    anyParsed: false,
  };

  for (const seed of sitemapSeeds) {
    // Only same-origin seeds are crawled (declared sitemaps could be off-origin).
    if (safeOrigin(seed) !== origin) continue;
    await crawlSitemap(seed, 0, state);
  }
  droppedBySsrf += state.droppedBySsrf;

  const sitemapFound = state.anyParsed && state.urls.length > 0;

  if (sitemapFound) {
    const usedIndex = state.visited.size > 1; // an index expanded to children
    const candidates = dedupe([homepage, ...state.urls]).filter((u) =>
      acceptSameOrigin(u, origin),
    );
    return {
      origin,
      candidates,
      source: usedIndex ? "sitemap-index" : "sitemap",
      robotsFound,
      sitemapFound: true,
      declaredSitemaps,
      droppedBySsrf,
      found: state.urls.length,
    };
  }

  // --- Step 3: nav-fallback --------------------------------------------------
  if (validateUrlForFetch(homepage).ok) {
    try {
      const res = await fetchRaw(homepage, opts);
      if (res.status === 200 && res.body.trim().length > 0) {
        const { links, dropped } = extractInternalLinks(
          res.body,
          res.finalUrl || homepage,
          origin,
        );
        droppedBySsrf += dropped;
        if (links.length > 0) {
          const candidates = dedupe([homepage, ...links]);
          return {
            origin,
            candidates,
            source: "nav-fallback",
            robotsFound,
            sitemapFound: false,
            declaredSitemaps,
            droppedBySsrf,
            found: links.length,
          };
        }
      }
    } catch {
      // fall through to "none"
    }
  } else {
    droppedBySsrf += 1;
  }

  // --- Nothing found: still return the homepage as the sole candidate --------
  return {
    origin,
    candidates: acceptSameOrigin(homepage, origin) ? [homepage] : [],
    source: "none",
    robotsFound,
    sitemapFound: false,
    declaredSitemaps,
    droppedBySsrf,
    found: 0,
  };
}
