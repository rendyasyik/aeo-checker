/**
 * Fetch and validate /llms.txt and /llms-full.txt at the site root.
 * Well-formedness follows the llms.txt spec shape: an H1 title, optional
 * blockquote summary, and H2 sections with markdown links.
 */

import { fetchRaw, originUrl, type FetchOptions } from "./fetcher.js";
import type { LlmsTxtResult } from "./context.js";

/** Check that llms.txt content is well-formed per the emerging spec. */
export function checkWellFormed(text: string): { ok: boolean; detail: string } {
  const trimmed = text.trim();
  if (!trimmed) return { ok: false, detail: "file is empty" };
  // Reject HTML served as llms.txt (misconfigured route).
  if (/^\s*<(!doctype|html|head|body)/i.test(trimmed)) {
    return { ok: false, detail: "response is HTML, not a markdown llms.txt" };
  }
  const lines = trimmed.split(/\r?\n/);
  const hasH1 = lines.some((l) => /^#\s+\S/.test(l));
  const hasH2 = lines.some((l) => /^##\s+\S/.test(l));
  const hasLink = /\[[^\]]+\]\([^)]+\)/.test(trimmed);

  if (!hasH1) return { ok: false, detail: "missing H1 title (# ...)" };
  if (!hasH2 && !hasLink) {
    return { ok: false, detail: "no H2 sections or markdown links found" };
  }
  return { ok: true, detail: "well-formed" };
}

export async function fetchLlmsTxt(
  url: string,
  opts: FetchOptions = {},
): Promise<LlmsTxtResult> {
  const result: LlmsTxtResult = {
    present: false,
    status: null,
    wellFormed: false,
    detail: "",
    fullPresent: false,
    fullStatus: null,
  };

  try {
    const res = await fetchRaw(originUrl(url, "/llms.txt"), opts);
    result.status = res.status;
    if (res.status === 200 && res.body.trim().length > 0) {
      result.present = true;
      const wf = checkWellFormed(res.body);
      result.wellFormed = wf.ok;
      result.detail = wf.detail;
    } else {
      result.detail = res.status === null ? (res.error ?? "unreachable") : `HTTP ${res.status}`;
    }
  } catch (e) {
    result.detail = e instanceof Error ? e.message : String(e);
  }

  try {
    const full = await fetchRaw(originUrl(url, "/llms-full.txt"), opts);
    result.fullStatus = full.status;
    result.fullPresent = full.status === 200 && full.body.trim().length > 0;
  } catch {
    // ignore
  }

  return result;
}
