/**
 * Raw HTML fetcher. Runtime-agnostic: uses only global fetch + Web-standard
 * APIs (AbortController, URL). No Node-only imports. Never renders JS.
 */

import { DEFAULT_TIMEOUT_MS, DEFAULT_USER_AGENT } from "./constants.js";

export interface FetchResult {
  /** Requested URL. */
  requestedUrl: string;
  /** Final URL after redirects. */
  finalUrl: string;
  /** HTTP status, or null if the request failed at the network level. */
  status: number | null;
  /** Response headers (lowercased keys), empty on network error. */
  headers: Record<string, string>;
  /** Response body text, or "" if unavailable. */
  body: string;
  /** Network/timeout error message, if any. */
  error: string | null;
}

export interface FetchOptions {
  timeoutMs?: number;
  userAgent?: string;
  /** Injectable fetch for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Fetch raw content (no JS execution) with a timeout and polite headers. */
export async function fetchRaw(
  url: string,
  opts: FetchOptions = {},
): Promise<FetchResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
  const doFetch = opts.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const base: FetchResult = {
    requestedUrl: url,
    finalUrl: url,
    status: null,
    headers: {},
    body: "",
    error: null,
  };

  try {
    const res = await doFetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "user-agent": userAgent,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "en-US,en;q=0.9",
      },
    });

    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });

    let body = "";
    try {
      body = await res.text();
    } catch {
      body = "";
    }

    return {
      requestedUrl: url,
      finalUrl: res.url || url,
      status: res.status,
      headers,
      body,
      error: null,
    };
  } catch (e) {
    const message =
      e instanceof Error
        ? e.name === "AbortError"
          ? `timeout after ${timeoutMs}ms`
          : e.message
        : String(e);
    return { ...base, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/** Join a path onto the origin of a URL (for robots.txt / llms.txt fetches). */
export function originUrl(url: string, path: string): string {
  const u = new URL(url);
  return `${u.origin}${path.startsWith("/") ? path : `/${path}`}`;
}
