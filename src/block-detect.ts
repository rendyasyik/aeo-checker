/**
 * Honest block detection. Classifies a fetched URL as OK / HARD_BLOCK /
 * SOFT_BLOCK so the report can distinguish "what an AI crawler can see" from
 * "what it cannot". Deterministic heuristics only.
 */

import type { BlockReport } from "./types.js";
import type { FetchResult } from "./fetcher.js";
import type { ParsedHtml } from "./html.js";

const HARD_BLOCK_STATUSES = new Set([401, 403, 407, 429, 451, 503]);

/** Textual fingerprints of common bot-challenge / anti-bot interstitials. */
const CHALLENGE_MARKERS = [
  "just a moment",
  "checking your browser",
  "cf-browser-verification",
  "cf_chl_",
  "__cf_chl",
  "attention required",
  "cloudflare ray id",
  "please enable javascript and cookies",
  "verifying you are human",
  "captcha-delivery",
  "px-captcha",
  "access denied",
  "request unsuccessful. incapsula",
  "ddos protection by",
];

/** Fingerprints of login / paywall / gated content on an HTTP 200 page. */
const GATE_MARKERS = [
  "please log in to continue",
  "sign in to continue",
  "subscribe to read",
  "subscribe to continue reading",
  "this content is for subscribers",
  "members only",
  "create a free account to continue",
  "you have reached your article limit",
  "to continue reading, please",
  "paywall",
];

function lc(s: string): string {
  return s.toLowerCase();
}

/** Detect a JS-only shell: almost no rendered text but heavy script payload. */
export function isJsOnlyShell(parsed: ParsedHtml): {
  jsOnly: boolean;
  reason: string;
} {
  const { wordCount, mainWordCount, scriptCount, scriptMarkupLength, root } =
    parsed;

  const hasNextData = root.querySelector("#__NEXT_DATA__") !== null;
  const hasEmptyRoot =
    (root.querySelector("#root")?.innerText.trim().length ?? -1) === 0 ||
    (root.querySelector("#app")?.innerText.trim().length ?? -1) === 0 ||
    (root.querySelector("#__next")?.innerText.trim().length ?? -1) === 0;

  // Very little rendered text.
  const textStarved = wordCount < 40 && mainWordCount < 25;
  // Script-heavy relative to visible text.
  const scriptHeavy = scriptCount >= 1 && scriptMarkupLength > 3000;

  if (textStarved && (scriptHeavy || hasNextData || hasEmptyRoot)) {
    const bits: string[] = [];
    if (hasNextData) bits.push("__NEXT_DATA__ present");
    if (hasEmptyRoot) bits.push("empty app root element");
    if (scriptHeavy) bits.push("large script payload");
    bits.push(`only ${wordCount} rendered words`);
    return { jsOnly: true, reason: bits.join(", ") };
  }
  return { jsOnly: false, reason: "" };
}

/**
 * Classify a fetch result. `parsed` may be null when the body could not be
 * parsed (e.g. network error).
 */
export function detectBlock(
  fetchRes: FetchResult,
  parsed: ParsedHtml | null,
): BlockReport {
  const status = fetchRes.status;

  // Network-level failure (DNS, connection, timeout).
  if (status === null) {
    return {
      status: "HARD_BLOCK",
      httpStatus: null,
      reason: "network_error",
      detail: `Could not fetch the page: ${fetchRes.error ?? "unknown error"}. An AI crawler would not be able to read it.`,
    };
  }

  // Explicit hard-block status codes.
  if (HARD_BLOCK_STATUSES.has(status)) {
    return {
      status: "HARD_BLOCK",
      httpStatus: status,
      reason: `http_${status}`,
      detail: `The server responded ${status}. An AI crawler is blocked from fetching this page.`,
    };
  }

  const bodyLc = lc(fetchRes.body).slice(0, 20000);

  // Bot-challenge interstitial served with any status (often 403/503, sometimes 200).
  const challengeHit = CHALLENGE_MARKERS.find((m) => bodyLc.includes(m));
  if (challengeHit) {
    return {
      status: "HARD_BLOCK",
      httpStatus: status,
      reason: "bot_challenge",
      detail: `A bot-protection challenge was detected ("${challengeHit}"). AI crawlers are effectively blocked.`,
    };
  }

  // Other non-2xx (e.g. 404, 5xx) — reachable but not usable content.
  if (status >= 400) {
    return {
      status: "HARD_BLOCK",
      httpStatus: status,
      reason: `http_${status}`,
      detail: `The server responded ${status}; no readable content for an AI crawler.`,
    };
  }
  if (status >= 300) {
    // Redirects are followed by fetch; a lingering 3xx here is unusual.
    return {
      status: "OK",
      httpStatus: status,
      reason: `http_${status}`,
      detail: `Redirect status ${status}.`,
    };
  }

  // HTTP 2xx from here on. Check soft-block conditions.
  const gateHit = GATE_MARKERS.find((m) => bodyLc.includes(m));
  if (gateHit) {
    return {
      status: "SOFT_BLOCK",
      httpStatus: status,
      reason: "gated_content",
      detail: `The page returned 200 but appears gated behind login/paywall ("${gateHit}"). AI crawlers likely see only the gate, not the content.`,
    };
  }

  if (parsed) {
    const shell = isJsOnlyShell(parsed);
    if (shell.jsOnly) {
      return {
        status: "SOFT_BLOCK",
        httpStatus: status,
        reason: "js_only_shell",
        detail: `The page returned 200 but its content is rendered by JavaScript (${shell.reason}). AI crawlers, which do not run JS, see an almost-empty page.`,
      };
    }
  }

  return {
    status: "OK",
    httpStatus: status,
    reason: "ok",
    detail: "The page is reachable and its content is present in the raw HTML.",
  };
}
