import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { scanUrl, scanSite } from "../src/tools.js";
import {
  makeNodeGuardedFetch,
  resolveAllowPrivateHosts,
} from "../src/guarded-fetch.js";

/**
 * Build an injectable fetch (`fetchImpl`) answering from an in-memory route
 * table, matching the subset the engine reads (status, url, headers.forEach,
 * text()). Any URL not in the table returns 404. No real network is touched.
 */
function mockFetch(
  routes: Record<string, { status?: number; body: string; headers?: Record<string, string> }>,
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const hit = routes[url];
    const status = hit ? (hit.status ?? 200) : 404;
    const body = hit ? hit.body : "";
    const headers = new Headers({ "content-type": "text/html", ...(hit?.headers ?? {}) });
    const res = new Response(body, { status, headers });
    Object.defineProperty(res, "url", { value: url, configurable: true });
    return res;
  }) as typeof fetch;
}

const RICH_PAGE = `<!doctype html><html lang="en"><head>
<title>How to brew pour-over coffee</title>
<meta name="description" content="A clear guide to pour-over coffee.">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"How long does it take?","acceptedAnswer":{"@type":"Answer","text":"About four minutes."}}]}</script>
</head><body>
<main>
<h1>How to brew pour-over coffee</h1>
<p>TL;DR: rinse the filter, add coffee, pour water in stages, and you get a clean cup in about four minutes of total brew time here.</p>
<h2>How much coffee should I use?</h2>
<p>Use a ratio of about sixteen grams of water to one gram of coffee for a balanced and repeatable extraction every single time you brew.</p>
<ol><li>Rinse the filter</li><li>Add ground coffee</li><li>Pour in stages</li></ol>
</main>
</body></html>`;

describe("aeo_scan_url", () => {
  it("returns extractedContent by default and full AeoReport JSON", async () => {
    const fetchImpl = mockFetch({
      "https://example.com/coffee": { body: RICH_PAGE },
    });
    const r = await scanUrl({ url: "https://example.com/coffee", fetchImpl });

    expect(r.isError).toBeFalsy();
    const report = r.structured as any;
    // Full report shape.
    expect(typeof report.total).toBe("number");
    expect(report.grade).toBeTruthy();
    // extractedContent present by DEFAULT (includeExtractedContent defaults true).
    expect(report.extractedContent).toBeTruthy();
    expect(report.extractedContent.mainText).toContain("pour-over");
    expect(report.extractedContent.wordCount).toBeGreaterThan(0);
    // Structural answer signals surfaced.
    const as = report.extractedContent.answerStructure;
    expect(as.faqSchema).toBe(true);
    expect(as.tldr).toBe(true);
    expect(as.orderedListCount).toBeGreaterThanOrEqual(1);
    // Human text carries the answer-ability guidance (the MCP differentiator).
    expect(r.text).toMatch(/answer-ability/i);
    expect(r.text).toMatch(/does NOT judge answer quality/i);
  });

  it("omits extractedContent when includeExtractedContent is false", async () => {
    const fetchImpl = mockFetch({
      "https://example.com/coffee": { body: RICH_PAGE },
    });
    const r = await scanUrl({
      url: "https://example.com/coffee",
      includeExtractedContent: false,
      fetchImpl,
    });
    const report = r.structured as any;
    expect(report.extractedContent).toBeUndefined();
  });
});

describe("aeo_scan_site", () => {
  it("returns a structural aggregate (siteScore + block distribution), no full content dump", async () => {
    const fetchImpl = mockFetch({
      "https://example.com/robots.txt": {
        body: "User-agent: *\nDisallow:\nSitemap: https://example.com/sitemap.xml",
      },
      "https://example.com/sitemap.xml": {
        headers: { "content-type": "text/xml" },
        body: `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://example.com/</loc></url>
<url><loc>https://example.com/blog/one</loc></url>
<url><loc>https://example.com/blog/two</loc></url>
</urlset>`,
      },
      "https://example.com/": { body: RICH_PAGE },
      "https://example.com/blog/one": { body: RICH_PAGE },
      "https://example.com/blog/two": { body: RICH_PAGE },
    });

    const r = await scanSite({ url: "https://example.com/", fetchImpl, concurrency: 2 });
    expect(r.isError).toBeFalsy();
    const site = r.structured as any;
    expect(site.origin).toBe("https://example.com");
    expect(Array.isArray(site.perPage)).toBe(true);
    expect(site.perPage.length).toBeGreaterThan(0);
    // Aggregate present.
    expect(site.siteScore).toBeTruthy();
    expect(site.blockDistribution).toBeTruthy();
    expect(Array.isArray(site.sampledPages)).toBe(true);
    // Structural aggregates only: no per-page extractedContent dumped.
    for (const p of site.perPage) {
      if (p.result) expect(p.result.extractedContent).toBeUndefined();
    }
    // Summary text mentions structural-only + host-LLM judgement.
    expect(r.text).toMatch(/STRUCTURAL AGGREGATES/i);
  });

  it("clamps maxPages to the hard cap and re-aggregates the reported pages", async () => {
    const routes: Record<string, { status?: number; body: string; headers?: Record<string, string> }> = {
      "https://example.com/robots.txt": {
        body: "User-agent: *\nDisallow:\nSitemap: https://example.com/sitemap.xml",
      },
      "https://example.com/": { body: RICH_PAGE },
    };
    // Build a sitemap with several blog URLs so >1 page is sampled.
    const locs = ["https://example.com/"];
    for (let i = 0; i < 6; i++) {
      const u = `https://example.com/blog/post-${i}`;
      locs.push(u);
      routes[u] = { body: RICH_PAGE };
    }
    routes["https://example.com/sitemap.xml"] = {
      headers: { "content-type": "text/xml" },
      body:
        `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
        locs.map((l) => `<url><loc>${l}</loc></url>`).join("") +
        `</urlset>`,
    };

    const r = await scanSite({
      url: "https://example.com/",
      maxPages: 1,
      fetchImpl: mockFetch(routes),
      concurrency: 2,
    });
    const site = r.structured as any;
    // maxPages=1 -> at most 1 page reported after clamp/trim.
    expect(site.perPage.length).toBe(1);
  });
});

describe("SSRF secure-by-default", () => {
  beforeEach(() => {
    delete process.env.AEO_ALLOW_PRIVATE_HOSTS;
  });
  afterEach(() => {
    delete process.env.AEO_ALLOW_PRIVATE_HOSTS;
  });

  it("blocks a private/internal host by default (no fetchImpl injected, real guard)", async () => {
    const r = await scanUrl({ url: "http://169.254.169.254/latest/meta-data" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/AEO_ALLOW_PRIVATE_HOSTS=1/);
    expect((r.structured as any).error).toBe("blocked_host");
  });

  it("blocks localhost by default", async () => {
    const r = await scanUrl({ url: "http://localhost:8080/" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/blocked private\/internal host/);
  });

  it("env AEO_ALLOW_PRIVATE_HOSTS=1 opens the guard (fetch then fails at network, NOT SSRF)", async () => {
    process.env.AEO_ALLOW_PRIVATE_HOSTS = "1";
    // Inject a mock so we never touch the real network; prove the guard did not
    // block the private host this time (the request reached the fetch layer).
    const fetchImpl = mockFetch({
      "http://127.0.0.1:9/": { body: "<html><head><title>local</title></head><body><p>ok</p></body></html>" },
    });
    const r = await scanUrl({ url: "http://127.0.0.1:9/", fetchImpl });
    // Not an SSRF block: it produced a real report.
    expect(r.isError).toBeFalsy();
    expect((r.structured as any).url).toBe("http://127.0.0.1:9/");
  });

  it("per-call allowPrivateHosts=true also opens the guard", async () => {
    const fetchImpl = mockFetch({
      "http://10.0.0.5/": { body: "<html><head><title>internal</title></head><body><p>ok</p></body></html>" },
    });
    const r = await scanUrl({ url: "http://10.0.0.5/", allowPrivateHosts: true, fetchImpl });
    expect(r.isError).toBeFalsy();
  });
});

describe("guard factory + resolveAllowPrivateHosts (guard is the flip point)", () => {
  beforeEach(() => delete process.env.AEO_ALLOW_PRIVATE_HOSTS);
  afterEach(() => delete process.env.AEO_ALLOW_PRIVATE_HOSTS);

  it("resolveAllowPrivateHosts: default secure, env=1 opens, per-call wins", () => {
    expect(resolveAllowPrivateHosts(undefined)).toBe(false);
    process.env.AEO_ALLOW_PRIVATE_HOSTS = "1";
    expect(resolveAllowPrivateHosts(undefined)).toBe(true);
    expect(resolveAllowPrivateHosts(false)).toBe(false); // explicit false wins over env
    delete process.env.AEO_ALLOW_PRIVATE_HOSTS;
    expect(resolveAllowPrivateHosts(true)).toBe(true);
  });

  it("guarded fetch THROWS ssrf_blocked for a private host when allowPrivateHosts=false", async () => {
    const gf = makeNodeGuardedFetch({
      timeoutMs: 2000,
      maxRedirects: 5,
      allowPrivateHosts: false,
    });
    await expect(gf("http://169.254.169.254/latest")).rejects.toThrow(/ssrf_blocked/);
  });
});
