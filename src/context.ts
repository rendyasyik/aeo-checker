/**
 * Analysis context shared by all dimension scorers. Assembled once by the
 * orchestrator so each dimension is a pure function of already-fetched data.
 */

import type { FetchResult } from "./fetcher.js";
import type { ParsedHtml } from "./html.js";
import type { ParsedRobots } from "./robots.js";
import type { SchemaExtraction } from "./schema-extract.js";
import type { BlockReport } from "./types.js";

export interface LlmsTxtResult {
  /** /llms.txt */
  present: boolean;
  status: number | null;
  wellFormed: boolean;
  detail: string;
  /** /llms-full.txt */
  fullPresent: boolean;
  fullStatus: number | null;
}

export interface AnalysisContext {
  url: string;
  finalUrl: string;
  /** Path portion of the URL, for robots evaluation. */
  path: string;
  page: FetchResult;
  parsed: ParsedHtml;
  block: BlockReport;
  robots: ParsedRobots | null;
  robotsFetched: boolean;
  schema: SchemaExtraction;
  llmsTxt: LlmsTxtResult;
}
