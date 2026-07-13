#!/usr/bin/env node
/**
 * AEO MCP server — the DEVELOPER FACE of the deterministic aeo-checker engine.
 *
 * Exposes two tools over stdio:
 *   - aeo_scan_url:  single-page AEO/AI-readiness scan + extracted content
 *                    (mainText + structural answer signals) for the host LLM to
 *                    judge answer-ability.
 *   - aeo_scan_site: multi-page site scan returning STRUCTURAL AGGREGATES only
 *                    (no full per-page content dump).
 *
 * The engine is DETERMINISTIC and does NOT judge answer quality. It measures
 * AI-readiness plumbing and surfaces the raw extracted text + structural
 * answer-structure signals so the HOST LLM can form the qualitative
 * answer-ability judgement. That division of labour is the point of this MCP
 * surface versus the deterministic public web tool.
 *
 * SSRF is SECURE BY DEFAULT: private / internal hosts are blocked unless the
 * developer explicitly opts in via AEO_ALLOW_PRIVATE_HOSTS=1 (env) or the
 * per-call allowPrivateHosts=true argument. There is no Turnstile / rate limit /
 * circuit breaker here on purpose: this is a local, single-developer stdio
 * server, not a shared public surface.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MAX_TOTAL_PAGES } from "../../dist/index.js";
import { scanUrl, scanSite, type ToolResult } from "./tools.js";

const server = new McpServer({
  name: "aeo-checker",
  version: "0.1.0",
});

/** Turn a ToolResult into MCP content: a text summary + the full JSON payload. */
function toMcpResult(r: ToolResult) {
  return {
    content: [
      { type: "text" as const, text: r.text },
      {
        type: "text" as const,
        text:
          "```json\n" + JSON.stringify(r.structured, null, 2) + "\n```",
      },
    ],
    ...(r.isError ? { isError: true } : {}),
  };
}

server.registerTool(
  "aeo_scan_url",
  {
    title: "Scan a single URL for AEO / AI-readiness",
    description:
      "Fetch one URL (raw HTML, no JS render) and score how ready it is to be " +
      "read and cited by AI crawlers, across six deterministic dimensions " +
      "(AI crawler access, content extractability without JS, structured data, " +
      "semantic structure, metadata/provenance, llms.txt). Returns the full " +
      "AeoReport as JSON plus a compact human summary. When " +
      "includeExtractedContent is true (default), it ALSO returns " +
      "extractedContent: the readable text an AI crawler actually sees plus " +
      "deterministic structural answer signals (FAQ schema, question headings, " +
      "answer paragraphs, TL;DR, step lists, HowTo schema). " +
      "IMPORTANT: this engine is deterministic and does NOT judge answer " +
      "quality; use extractedContent.mainText + answerStructure to judge " +
      "answer-ability yourself. SSRF is secure by default (private/internal " +
      "hosts blocked; set AEO_ALLOW_PRIVATE_HOSTS=1 or allowPrivateHosts=true " +
      "to allow).",
    inputSchema: {
      url: z.string().url().describe("The absolute http/https URL to scan."),
      includeExtractedContent: z
        .boolean()
        .optional()
        .describe(
          "Attach extractedContent (mainText + answerStructure) for answer-ability judgement. Default true.",
        ),
      allowPrivateHosts: z
        .boolean()
        .optional()
        .describe(
          "Explicit opt-in to allow private/internal hosts, overriding the secure default. Use only knowingly.",
        ),
    },
  },
  async (args) => {
    const r = await scanUrl({
      url: args.url,
      includeExtractedContent: args.includeExtractedContent,
      allowPrivateHosts: args.allowPrivateHosts,
    });
    return toMcpResult(r);
  },
);

server.registerTool(
  "aeo_scan_site",
  {
    title: "Scan a site (sampled pages) for AEO / AI-readiness",
    description:
      "Discover a site (robots.txt / sitemap / nav fallback), deterministically " +
      "section-sample up to " +
      MAX_TOTAL_PAGES +
      " pages, scan each with the single-page engine, and return an HONEST " +
      "site-level aggregate: a 30/70 site-vs-page ESTIMATE score, per-page mean/" +
      "median/spread, block distribution, coverage gap (pages an AI crawler " +
      "could not access, excluded not scored 0), and a sampled-page list. " +
      "Returns the full SiteScanResult as JSON plus a compact summary. " +
      "NOTE: this returns STRUCTURAL AGGREGATES ONLY — it does NOT dump full " +
      "per-page extracted text (that would be enormous). To read a single " +
      "page's mainText + answerStructure, call aeo_scan_url on that URL. SSRF " +
      "is secure by default (set AEO_ALLOW_PRIVATE_HOSTS=1 or " +
      "allowPrivateHosts=true to allow internal hosts).",
    inputSchema: {
      url: z
        .string()
        .url()
        .describe("Any absolute http/https URL on the site; the scan is rooted at its origin."),
      maxPages: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          "Upper bound on pages to report (clamped to the hard cap " +
            MAX_TOTAL_PAGES +
            "). Defaults to the hard cap.",
        ),
      allowPrivateHosts: z
        .boolean()
        .optional()
        .describe(
          "Explicit opt-in to allow private/internal hosts, overriding the secure default. Use only knowingly.",
        ),
    },
  },
  async (args) => {
    const r = await scanSite({
      url: args.url,
      maxPages: args.maxPages,
      allowPrivateHosts: args.allowPrivateHosts,
    });
    return toMcpResult(r);
  },
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Announce on stderr (stdout is the JSON-RPC channel and must stay clean).
  process.stderr.write("aeo-checker MCP server running on stdio\n");
}

main().catch((err) => {
  process.stderr.write(
    `aeo-checker MCP server fatal: ${err instanceof Error ? err.stack : String(err)}\n`,
  );
  process.exit(1);
});
