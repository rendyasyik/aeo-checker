/**
 * SSRF guard — re-export of the shared core-lib implementation.
 *
 * The guard logic now lives in the core lib (`src/ssrf.ts`) so a single source
 * of truth protects the Worker fetch path, the MCP server, and the site-scan
 * discovery/sampling module. This file preserves the worker's `./ssrf.js`
 * import surface while delegating to the core module (no behavioural drift).
 */

export { validateUrlForFetch, type SsrfCheck } from "../../src/ssrf.js";
