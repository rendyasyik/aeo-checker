import { describe, it, expect } from "vitest";
import { parseRobots, isAllowed } from "../src/robots.js";
import { extractSchema } from "../src/schema-extract.js";
import { parseHtml } from "../src/html.js";
import { checkWellFormed } from "../src/llms-fetch.js";
import { fixture } from "./helpers.js";

describe("robots parser", () => {
  const robots = parseRobots(fixture("robots-block-ai.txt"));

  it("blocks GPTBot at root", () => {
    expect(isAllowed(robots, "GPTBot", "/").allowed).toBe(false);
  });

  it("allows a generic user-agent at root", () => {
    expect(isAllowed(robots, "Mozilla", "/").allowed).toBe(true);
  });

  it("applies longest-match: Allow beats a shorter Disallow", () => {
    const r = parseRobots("User-agent: *\nDisallow: /blog\nAllow: /blog/public");
    expect(isAllowed(r, "GPTBot", "/blog/private").allowed).toBe(false);
    expect(isAllowed(r, "GPTBot", "/blog/public/post").allowed).toBe(true);
  });

  it("treats empty Disallow as allow-all", () => {
    const r = parseRobots("User-agent: *\nDisallow:");
    expect(isAllowed(r, "GPTBot", "/anything").allowed).toBe(true);
  });

  it("captures sitemaps", () => {
    expect(robots.sitemaps).toContain("https://example.com/sitemap.xml");
  });

  it("handles $ end-anchor and * wildcards", () => {
    const r = parseRobots("User-agent: *\nDisallow: /*.pdf$");
    expect(isAllowed(r, "GPTBot", "/files/report.pdf").allowed).toBe(false);
    expect(isAllowed(r, "GPTBot", "/files/report.html").allowed).toBe(true);
  });
});

describe("schema extraction", () => {
  it("collects nested @graph types and finds sameAs nodes", () => {
    const root = parseHtml(fixture("schema-rich.html")).root;
    const s = extractSchema(root);
    expect(s.jsonLdTypes).toEqual(
      expect.arrayContaining(["Organization", "WebSite", "Article", "FAQPage", "BreadcrumbList", "Person"]),
    );
    expect(s.jsonLdInvalidCount).toBe(0);
    expect(s.hasAny).toBe(true);
  });

  it("counts invalid JSON-LD blocks without throwing", () => {
    const root = parseHtml(
      '<html><head><script type="application/ld+json">{ not valid json }</script></head><body></body></html>',
    ).root;
    const s = extractSchema(root);
    expect(s.jsonLdInvalidCount).toBe(1);
    expect(s.jsonLdTypes).toEqual([]);
  });

  it("detects microdata best-effort", () => {
    const root = parseHtml(
      '<html><body><div itemscope itemtype="https://schema.org/Product"><span>X</span></div></body></html>',
    ).root;
    const s = extractSchema(root);
    expect(s.microdataTypes).toContain("Product");
  });
});

describe("html text metrics", () => {
  it("extracts visible text and excludes script content", () => {
    const p = parseHtml(
      '<html><body><main><p>Hello world here is text.</p></main><script>var secret="do not count me";</script></body></html>',
    );
    expect(p.visibleText).toContain("Hello world");
    expect(p.visibleText).not.toContain("do not count me");
    expect(p.wordCount).toBeGreaterThanOrEqual(5);
  });
});

describe("llms.txt well-formedness", () => {
  it("accepts a spec-shaped file", () => {
    expect(checkWellFormed(fixture("llms.txt")).ok).toBe(true);
  });

  it("rejects an empty file", () => {
    expect(checkWellFormed("").ok).toBe(false);
  });

  it("rejects HTML served as llms.txt", () => {
    expect(checkWellFormed("<!doctype html><html></html>").ok).toBe(false);
  });

  it("rejects a file with no H1", () => {
    expect(checkWellFormed("Just some text\n- [a](https://x.com)").ok).toBe(false);
  });
});
