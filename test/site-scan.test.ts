import { describe, it, expect } from "vitest";
import { fixture } from "./helpers.js";
import { validateUrlForFetch } from "../src/ssrf.js";
import {
  discover,
  DISCOVERY_LIMITS,
} from "../src/site-scan/discovery.js";
import {
  sample,
  sectionOf,
  MAX_TOTAL_PAGES,
  PER_SECTION,
  ROOT_SECTION,
} from "../src/site-scan/sampling.js";
import { siteScan, aggregateSiteScore } from "../src/site-scan/orchestrator.js";

/**
 * Build an injectable fetch (`fetchImpl`) that answers from an in-memory route
 * table. Any URL not in the table returns 404. Returns a Response-like object
 * matching the subset the engine reads (status, url, headers.forEach, text()).
 */
function mockFetch(routes: Record<string, { status?: number; body: string }>) {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const hit = routes[url];
    const status = hit ? (hit.status ?? 200) : 404;
    const body = hit ? hit.body : "";
    const headers = new Headers({ "content-type": "text/xml" });
    const res = new Response(body, { status, headers });
    Object.defineProperty(res, "url", { value: url, configurable: true });
    return res;
  }) as typeof fetch;
}

const ORIGIN = "https://example.com";

describe("SSRF guard (core lib)", () => {
  it("drops cloud-metadata, loopback and RFC1918 hosts", () => {
    expect(validateUrlForFetch("http://169.254.169.254/latest").ok).toBe(false);
    expect(validateUrlForFetch("http://localhost/").ok).toBe(false);
    expect(validateUrlForFetch("http://10.0.0.1/").ok).toBe(false);
    expect(validateUrlForFetch("http://127.0.0.1/").ok).toBe(false);
    expect(validateUrlForFetch("http://192.168.1.1/").ok).toBe(false);
    expect(validateUrlForFetch("http://[::1]/").ok).toBe(false);
  });
  it("allows public http/https hosts", () => {
    expect(validateUrlForFetch("https://example.com/blog").ok).toBe(true);
  });
  it("rejects non-http schemes", () => {
    expect(validateUrlForFetch("file:///etc/passwd").ok).toBe(false);
  });
});

describe("discovery: robots Sitemap + sitemap index recursion", () => {
  const fetchImpl = mockFetch({
    "https://example.com/robots.txt": {
      body: "User-agent: *\nDisallow:\nSitemap: https://example.com/sitemap-index.xml",
    },
    "https://example.com/sitemap-index.xml": { body: fixture("sitemap-index.xml") },
    "https://example.com/sitemap-blog.xml": { body: fixture("sitemap-blog.xml") },
    "https://example.com/sitemap-news.xml": { body: fixture("sitemap-news.xml") },
  });

  it("parses declared sitemap, recurses the index, collects same-origin URLs", async () => {
    const d = await discover(ORIGIN, { fetchImpl });
    expect(d.robotsFound).toBe(true);
    expect(d.sitemapFound).toBe(true);
    expect(d.source).toBe("sitemap-index");
    expect(d.declaredSitemaps).toContain("https://example.com/sitemap-index.xml");
    // Homepage always present + all 5 child URLs.
    expect(d.candidates).toContain("https://example.com/");
    expect(d.candidates).toContain("https://example.com/blog/alpha");
    expect(d.candidates).toContain("https://example.com/news/two");
    expect(d.found).toBe(5);
  });
});

describe("discovery: recursion depth + URL cap constants", () => {
  it("exposes tunable limits", () => {
    expect(DISCOVERY_LIMITS.MAX_SITEMAP_DEPTH).toBe(2);
    expect(DISCOVERY_LIMITS.MAX_SITEMAP_URLS).toBe(2000);
  });

  it("respects MAX_SITEMAP_URLS cap", async () => {
    // Build a urlset with more URLs than the cap allows.
    const n = DISCOVERY_LIMITS.MAX_SITEMAP_URLS + 50;
    const locs = Array.from(
      { length: n },
      (_, i) => `<url><loc>https://example.com/p/${i}</loc></url>`,
    ).join("");
    const big = `<?xml version="1.0"?><urlset>${locs}</urlset>`;
    const fetchImpl = mockFetch({
      "https://example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/sitemap.xml": { body: big },
    });
    const d = await discover(ORIGIN, { fetchImpl });
    // candidates includes homepage; page URLs capped at MAX_SITEMAP_URLS.
    expect(d.candidates.length).toBeLessThanOrEqual(
      DISCOVERY_LIMITS.MAX_SITEMAP_URLS + 1,
    );
  });
});

describe("discovery: nav-fallback when no sitemap", () => {
  it("extracts same-origin links from the homepage", async () => {
    const html = `<!doctype html><html><body>
      <a href="/about">About</a>
      <a href="/blog/first-post">Post</a>
      <a href="https://example.com/contact">Contact</a>
      <a href="https://other.com/x">External</a>
      <a href="mailto:hi@example.com">Mail</a>
      <a href="#section">Anchor</a>
    </body></html>`;
    const fetchImpl = mockFetch({
      "https://example.com/robots.txt": { status: 404, body: "" },
      "https://example.com/sitemap.xml": { status: 404, body: "" },
      "https://example.com/": { body: html },
    });
    const d = await discover(ORIGIN, { fetchImpl });
    expect(d.source).toBe("nav-fallback");
    expect(d.sitemapFound).toBe(false);
    expect(d.candidates).toContain("https://example.com/");
    expect(d.candidates).toContain("https://example.com/about");
    expect(d.candidates).toContain("https://example.com/blog/first-post");
    expect(d.candidates).toContain("https://example.com/contact");
    // External / mailto / anchor are excluded.
    expect(d.candidates).not.toContain("https://other.com/x");
    expect(d.candidates.some((u) => u.startsWith("mailto"))).toBe(false);
  });
});

describe("discovery: SSRF drops internal candidate URLs", () => {
  it("drops a sitemap loc that resolves to a private host and counts it", async () => {
    // Same-origin sitemap, but with an entry pointing at a private IP host is
    // off-origin so it's excluded by origin, not SSRF. To exercise SSRF drop we
    // point robots at an internal sitemap URL (still same-origin host is public,
    // so instead craft an origin whose homepage is internal).
    const internalOrigin = "http://169.254.169.254";
    const fetchImpl = mockFetch({});
    const d = await discover(internalOrigin, { fetchImpl });
    // Homepage itself fails the guard -> no candidates, drop counted.
    expect(d.candidates.length).toBe(0);
    expect(d.droppedBySsrf).toBeGreaterThan(0);
  });
});

describe("sampling: section clustering", () => {
  it("clusters by first path segment; root-level -> root", () => {
    expect(sectionOf("https://example.com/")).toBe(ROOT_SECTION);
    expect(sectionOf("https://example.com/about")).toBe(ROOT_SECTION);
    expect(sectionOf("https://example.com/blog/x")).toBe("blog");
    expect(sectionOf("https://example.com/news/y")).toBe("news");
    expect(sectionOf("https://example.com/product/z")).toBe("product");
  });
});

describe("sampling: homepage always included + 2 per section deterministic", () => {
  const candidates = [
    "https://example.com/",
    "https://example.com/blog/gamma",
    "https://example.com/blog/alpha",
    "https://example.com/blog/beta",
    "https://example.com/news/two",
    "https://example.com/news/one",
    "https://example.com/product/z",
  ];

  it("always includes homepage and takes lexicographically-first 2 per section", () => {
    const s = sample(candidates, ORIGIN);
    expect(s.sampled[0]).toBe("https://example.com/");
    // blog: alpha, beta (lexicographic first two, not gamma)
    const blog = s.sections.find((x) => x.section === "blog");
    expect(blog?.urls).toEqual([
      "https://example.com/blog/alpha",
      "https://example.com/blog/beta",
    ]);
    // news: one, two
    const news = s.sections.find((x) => x.section === "news");
    expect(news?.urls).toEqual([
      "https://example.com/news/one",
      "https://example.com/news/two",
    ]);
  });

  it("is deterministic: same input -> identical output & order", () => {
    const a = sample(candidates, ORIGIN);
    const b = sample([...candidates].reverse(), ORIGIN);
    expect(a.sampled).toEqual(b.sampled);
    expect(a.sections).toEqual(b.sections);
  });

  it("never exceeds PER_SECTION per section", () => {
    const s = sample(candidates, ORIGIN);
    for (const sec of s.sections) {
      expect(sec.urls.length).toBeLessThanOrEqual(PER_SECTION);
    }
  });
});

describe("sampling: MAX_TOTAL_PAGES cost fence + section prioritization", () => {
  it("caps total pages and prioritizes larger sections, homepage exempt", () => {
    // Build many sections, each with 2 URLs => way over the cap.
    const candidates: string[] = ["https://example.com/"];
    const sectionCount = 20; // 20*2 = 40 >> MAX_TOTAL_PAGES
    for (let i = 0; i < sectionCount; i++) {
      const sec = `s${String(i).padStart(2, "0")}`;
      candidates.push(`https://example.com/${sec}/a`);
      candidates.push(`https://example.com/${sec}/b`);
    }
    const s = sample(candidates, ORIGIN);
    expect(s.sampled.length).toBeLessThanOrEqual(MAX_TOTAL_PAGES);
    // Homepage always survives the cap.
    expect(s.sampled).toContain("https://example.com/");
    // Some sections must be reported truncated for honesty.
    expect(s.truncatedSections.length).toBeGreaterThan(0);
  });

  it("prioritizes sections by URL count desc, then name asc", () => {
    // "big" has 5 urls, "small" has 1; with a tiny effective budget the big one
    // must be chosen first. We simulate over-cap by many sections.
    const candidates: string[] = ["https://example.com/"];
    // big section
    for (const c of ["a", "b", "c", "d", "e"]) {
      candidates.push(`https://example.com/big/${c}`);
    }
    // fill remaining budget with single-url sections
    for (let i = 0; i < MAX_TOTAL_PAGES + 5; i++) {
      candidates.push(`https://example.com/z${String(i).padStart(2, "0")}/only`);
    }
    const s = sample(candidates, ORIGIN);
    const big = s.sections.find((x) => x.section === "big");
    // "big" is the largest section so it must be chosen (2 taken).
    expect(big).toBeDefined();
    expect(big?.urls).toEqual([
      "https://example.com/big/a",
      "https://example.com/big/b",
    ]);
  });
});

describe("orchestrator: discovery -> sampling -> per-page scan -> aggregation", () => {
  const html = `<!doctype html><html><head><title>T</title></head>
    <body><main><h1>Hello</h1><p>Some readable content for the engine.</p></main></body></html>`;
  const fetchImpl = mockFetch({
    "https://example.com/robots.txt": {
      body: "User-agent: *\nDisallow:\nSitemap: https://example.com/sitemap-blog.xml",
    },
    "https://example.com/sitemap-blog.xml": { body: fixture("sitemap-blog.xml") },
    // pages (and their aux robots/llms probes) all return the same html/404.
    "https://example.com/": { body: html },
    "https://example.com/blog/alpha": { body: html },
    "https://example.com/blog/beta": { body: html },
  });

  it("returns raw per-page results + a populated site score", async () => {
    const scan = await siteScan(ORIGIN, { fetchImpl });
    expect(scan.origin).toBe(ORIGIN);
    expect(scan.discovery.source).toBe("sitemap");
    // homepage + 2 blog samples (blog section capped at PER_SECTION=2).
    const urls = scan.perPage.map((p) => p.url).sort();
    expect(urls).toContain("https://example.com/");
    expect(urls).toContain("https://example.com/blog/alpha");
    expect(urls).toContain("https://example.com/blog/beta");
    // Each per-page entry carries a real report.
    for (const p of scan.perPage) {
      expect(p.result).not.toBeNull();
      expect(typeof p.result?.total).toBe("number");
    }
    // Step 3: a site score is now computed (no longer null).
    expect(scan.siteScore).not.toBeNull();
    expect(scan.siteScore?.isEstimate).toBe(true);
    expect(typeof scan.siteScore?.total).toBe("number");
    expect(scan.siteScore?.siteLevel.max).toBe(30);
    expect(scan.siteScore?.pageLevel.maxPossible).toBe(70);
    // All three OK pages count toward the mean; nothing hard-blocked.
    expect(scan.siteScore?.pageLevel.countedPages).toBe(3);
    expect(scan.siteScore?.pageLevel.excludedHardBlock).toBe(0);
    expect(scan.coverageGap?.inaccessible).toBe(0);
    expect(scan.sampledPages.length).toBe(3);
    expect(scan.answerReadinessBeta?.mean).not.toBeNull();
  });

  it("aggregateSiteScore returns the full honest roll-up", async () => {
    const scan = await siteScan(ORIGIN, { fetchImpl });
    const agg = aggregateSiteScore(scan);
    expect(agg).toHaveProperty("siteScore");
    expect(agg).toHaveProperty("blockDistribution");
    expect(agg).toHaveProperty("coverageGap");
    expect(agg).toHaveProperty("sampledPages");
    expect(agg.siteScore.isEstimate).toBe(true);
    // Site-level portion is the homepage's robots+llms, judged once.
    expect(agg.siteScore.siteLevel.source).toBe("https://example.com/");
  });
});
