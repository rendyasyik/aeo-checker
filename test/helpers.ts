/**
 * Test helpers: build an AnalysisContext from raw fixture strings so scoring is
 * exercised deterministically with no network.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseHtml } from "../src/html.js";
import { detectBlock } from "../src/block-detect.js";
import { extractSchema } from "../src/schema-extract.js";
import { parseRobots } from "../src/robots.js";
import { checkWellFormed } from "../src/llms-fetch.js";
import type { FetchResult } from "../src/fetcher.js";
import type { AnalysisContext, LlmsTxtResult } from "../src/context.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export function fixture(name: string): string {
  return readFileSync(join(HERE, "fixtures", name), "utf8");
}

export interface BuildCtxOpts {
  url?: string;
  status?: number;
  headers?: Record<string, string>;
  robotsTxt?: string | null;
  llmsTxt?: string | null;
  llmsFull?: boolean;
}

export function buildContext(html: string, opts: BuildCtxOpts = {}): AnalysisContext {
  const url = opts.url ?? "https://example.com/";
  const status = opts.status ?? 200;
  const headers = opts.headers ?? {};

  const page: FetchResult = {
    requestedUrl: url,
    finalUrl: url,
    status,
    headers,
    body: html,
    error: null,
  };

  const parsed = parseHtml(html);
  const block = detectBlock(page, parsed);
  const schema = extractSchema(parsed.root);

  const robots = opts.robotsTxt != null ? parseRobots(opts.robotsTxt) : null;
  const robotsFetched = opts.robotsTxt != null;

  const llmsTxt: LlmsTxtResult =
    opts.llmsTxt != null
      ? {
          present: true,
          status: 200,
          wellFormed: checkWellFormed(opts.llmsTxt).ok,
          detail: checkWellFormed(opts.llmsTxt).detail,
          fullPresent: !!opts.llmsFull,
          fullStatus: opts.llmsFull ? 200 : 404,
        }
      : {
          present: false,
          status: 404,
          wellFormed: false,
          detail: "HTTP 404",
          fullPresent: false,
          fullStatus: 404,
        };

  let path = "/";
  try {
    path = new URL(url).pathname || "/";
  } catch {
    path = "/";
  }

  return {
    url,
    finalUrl: url,
    path,
    page,
    parsed,
    block,
    robots,
    robotsFetched,
    schema,
    llmsTxt,
  };
}
