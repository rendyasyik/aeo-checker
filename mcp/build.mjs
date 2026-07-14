// Build the AEO MCP server into a single self-contained ESM bundle.
//
// The MCP entry (src/index.ts) imports the deterministic core engine from the
// parent repo's compiled output (../../dist/*.js), which in turn depends on
// node-html-parser. Those live OUTSIDE this package folder, so a plain `tsc`
// build would emit `../../dist/...` import paths that do not exist inside the
// published npm tarball. To ship a working package we bundle everything the
// server needs into dist/index.js, inlining the core engine + node-html-parser,
// and keep only the two declared runtime dependencies external so npm installs
// them normally.
import { build } from "esbuild";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Declared runtime dependencies: resolved from the consumer's node_modules.
  external: ["@modelcontextprotocol/sdk", "zod"],
  // The source entry (src/index.ts) already carries the `#!/usr/bin/env node`
  // shebang; esbuild preserves it, so no banner is needed here.
  legalComments: "none",
  logLevel: "info",
});

console.error("[build] wrote dist/index.js (self-contained bundle)");
