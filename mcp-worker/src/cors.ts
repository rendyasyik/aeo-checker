/**
 * CORS for the remote MCP Worker.
 *
 * A remote MCP server is called by the MCP host (claude.ai / Claude Desktop /
 * Claude mobile) over Streamable HTTP, and by the browser during the OAuth
 * discovery + authorize flow. Unlike the REST Worker (which is locked to the
 * rendyandriyanto.com apex), this surface must allow the Claude web origins so
 * the in-browser connector setup and the streamed tool calls work.
 *
 * We echo the request Origin back ONLY when it is in the allowlist (never "*"),
 * and always set `Vary: Origin` so a cache never leaks one origin's response to
 * another. The MCP transport also needs `mcp-session-id` and `mcp-protocol-
 * version` to be readable by the client, so they are exposed. Extra origins
 * (e.g. a staging preview) can be added via the ALLOWED_ORIGINS env var.
 */

/**
 * Claude host origins that initiate the connector flow + tool calls. Kept as a
 * small explicit allowlist rather than a wildcard so the surface stays tight.
 */
const DEFAULT_ALLOWED = [
  "https://claude.ai",
  "https://www.claude.ai",
  "https://claude.com",
  "https://www.claude.com",
];

export interface CorsEnv {
  /** Comma-separated extra allowed origins (staging/preview). Optional. */
  ALLOWED_ORIGINS?: string;
}

export function allowedOrigins(env: CorsEnv): string[] {
  const extra = (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return Array.from(new Set([...DEFAULT_ALLOWED, ...extra]));
}

export function isOriginAllowed(origin: string | null, env: CorsEnv): boolean {
  if (!origin) return false;
  return allowedOrigins(env).includes(origin);
}

/**
 * Build CORS response headers for a given origin. When the origin is allowed we
 * echo it; when it is not allowed we omit ACAO entirely (the browser then blocks
 * the read). `Authorization` is allowed so the bearer token can be sent on tool
 * calls; the MCP session/protocol headers are allowed on the request and
 * exposed on the response.
 */
export function corsHeaders(
  origin: string | null,
  env: CorsEnv,
): Record<string, string> {
  const base: Record<string, string> = {
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
      "Content-Type, Authorization, mcp-session-id, mcp-protocol-version, last-event-id",
    "Access-Control-Expose-Headers": "mcp-session-id, mcp-protocol-version",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  if (origin && isOriginAllowed(origin, env)) {
    base["Access-Control-Allow-Origin"] = origin;
  }
  return base;
}
