/**
 * Locked-down CORS (mitigation layer 1).
 * Allow-Origin is echoed back ONLY when the request Origin is in the allowlist,
 * never "*". The production default allowlist is the rendyandriyanto.com apex +
 * www; extra origins (e.g. http://localhost:5173 for local dev) can be added
 * via the ALLOWED_ORIGINS env var (comma-separated).
 */

const DEFAULT_ALLOWED = [
  "https://rendyandriyanto.com",
  "https://www.rendyandriyanto.com",
];

export function allowedOrigins(env: { ALLOWED_ORIGINS?: string }): string[] {
  const extra = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // De-dupe while preserving the locked defaults first.
  return Array.from(new Set([...DEFAULT_ALLOWED, ...extra]));
}

export function isOriginAllowed(
  origin: string | null,
  env: { ALLOWED_ORIGINS?: string },
): boolean {
  if (!origin) return false;
  return allowedOrigins(env).includes(origin);
}

/**
 * Build CORS response headers for a given (already validated or not) origin.
 * When the origin is allowed we echo it and set Vary: Origin so caches don't
 * leak one origin's response to another. When it is not allowed we return no
 * ACAO header at all (the browser then blocks the read).
 */
export function corsHeaders(
  origin: string | null,
  env: { ALLOWED_ORIGINS?: string },
): Record<string, string> {
  const base: Record<string, string> = {
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && isOriginAllowed(origin, env)) {
    base["Access-Control-Allow-Origin"] = origin;
  }
  return base;
}
