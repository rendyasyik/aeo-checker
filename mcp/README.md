# @aeo-checker/mcp

MCP (Model Context Protocol) server that exposes the deterministic
**aeo-checker** engine to an AI coding host (Claude Desktop, OpenAI Codex,
Cursor, or any MCP client) as two developer tools:

- **`aeo_scan_url`** — scan one URL for AEO / AI-readiness and return the
  extracted page content + structural answer signals.
- **`aeo_scan_site`** — discover + sample a site and return an honest
  site-level aggregate (structural only, no full content dump).

The engine is **deterministic** and **does not judge answer quality**. It
measures AI-readiness plumbing (crawler access, extractability without JS,
schema, semantic structure, metadata/provenance, `llms.txt`) and hands you the
raw extracted text plus structural answer-structure signals. **Judging
answer-ability — does this page actually answer the user's question well? — is
the host LLM's job.** That division of labour is the whole point of this MCP
surface versus the deterministic public web tool.

> Status: not yet published to npm and the source repo is not yet public
> (planned for Fase 5). For now, run it from a local build as shown below.

---

## Requirements

- Node.js **>= 22** (uses the built-in global `fetch`).

## Build

The MCP server imports the core engine from the parent repo's compiled output,
so build the core lib first, then the MCP server:

```bash
# from the repo root
npm install            # core lib deps
npm run build          # builds core -> dist/

cd mcp
npm install            # MCP server deps
npm run build          # builds MCP -> mcp/dist/
```

After a successful build the runnable entry point is:

```
<repo>/mcp/dist/index.js
```

## Run (standalone smoke check)

```bash
node <repo>/mcp/dist/index.js
# stderr: "aeo-checker MCP server running on stdio"
```

The server speaks JSON-RPC over **stdio**; it is meant to be launched by an MCP
host, not used interactively.

---

## Register with a host

In every snippet below, replace `/ABS/PATH/TO/aeo-checker` with the absolute
path to this repository on your machine. The command is always `node` and the
argument is the built entry point.

### Claude Desktop

Edit `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "aeo-checker": {
      "command": "node",
      "args": ["/ABS/PATH/TO/aeo-checker/mcp/dist/index.js"]
    }
  }
}
```

Restart Claude Desktop; the two tools appear under the MCP tools menu.

### OpenAI Codex (CLI / IDE)

Codex CLI stores MCP servers in `~/.codex/config.toml` under a
`[mcp_servers.<name>]` table (note the **underscore** in `mcp_servers`; a hyphen
is silently ignored). Add:

```toml
[mcp_servers.aeo-checker]
command = "node"
args = ["/ABS/PATH/TO/aeo-checker/mcp/dist/index.js"]

# Optional: allow scanning private/internal hosts (off by default; see SSRF).
[mcp_servers.aeo-checker.env]
AEO_ALLOW_PRIVATE_HOSTS = "1"
```

Or add it with the Codex CLI helper (equivalent to the TOML above):

```bash
codex mcp add aeo-checker -- node /ABS/PATH/TO/aeo-checker/mcp/dist/index.js
# with an env var:
codex mcp add aeo-checker --env AEO_ALLOW_PRIVATE_HOSTS=1 -- node /ABS/PATH/TO/aeo-checker/mcp/dist/index.js
```

`codex mcp list` shows registered servers. The ChatGPT desktop app, Codex CLI,
and the IDE extension share this config.

> Config format verified against the official OpenAI Codex docs
> (`https://developers.openai.com/codex/mcp`, redirecting to
> `learn.chatgpt.com/docs/extend/mcp`): STDIO servers use
> `[mcp_servers.<name>]` with `command`, `args`, and an optional `[...env]`
> table, and the `codex mcp add` command is supported.

### Cursor

Global config at `~/.cursor/mcp.json`, or per-project at
`<project>/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "aeo-checker": {
      "command": "node",
      "args": ["/ABS/PATH/TO/aeo-checker/mcp/dist/index.js"]
    }
  }
}
```

Reload Cursor; enable the server in Settings -> MCP if prompted.

---

## Tools

### `aeo_scan_url`

Input:

| field | type | default | notes |
| --- | --- | --- | --- |
| `url` | string (http/https) | — | required |
| `includeExtractedContent` | boolean | `true` | attach `extractedContent` |
| `allowPrivateHosts` | boolean | `false` | explicit SSRF opt-in |

Returns a compact human-readable summary **and** the full `AeoReport` JSON. When
`includeExtractedContent` is true (default), the report includes
`extractedContent`:

- `mainText` — the readable text an AI crawler sees from the raw HTML (no JS
  render), capped at 20,000 chars (`truncated` / `originalLength` tell you if it
  was cut);
- `wordCount`, `blocked`;
- `answerStructure` — deterministic structural signals: `faqSchema`,
  `faqBlock`, `questionHeadingCount`, `answerParagraphCount`, `tldr`,
  `orderedListCount`, `howToSchema`.

Example call (arguments an MCP host would send):

```json
{ "name": "aeo_scan_url", "arguments": { "url": "https://example.com/blog/pour-over" } }
```

Example summary (abridged):

```
AEO scan: https://example.com/blog/pour-over
Score: 78/100 (grade B)
Block status: OK
Answer-readiness (beta, structural proxy, NOT quality): 64/100 (grade C)
Dimensions:
  - AI Crawler Access: 22/22
  - Content Extractability without JS: 18/22
  ...
Top fixes (impact-first):
  - [high] Add FAQPage/HowTo JSON-LD for answer-friendly schema (~+6)
Extracted content: 812 words
Answer structure: faqSchema=true faqBlock=false questionHeadings=3 answerParagraphs=5 tldr=true orderedLists=1 howToSchema=false

GUIDANCE: This engine is DETERMINISTIC and does NOT judge answer quality...
```

### `aeo_scan_site`

Input:

| field | type | default | notes |
| --- | --- | --- | --- |
| `url` | string (http/https) | — | required; scan is rooted at the origin |
| `maxPages` | integer | hard cap (15) | clamped to `[1, 15]` |
| `allowPrivateHosts` | boolean | `false` | explicit SSRF opt-in |

Discovers the site (robots.txt / sitemap / nav fallback), deterministically
section-samples up to 15 pages, scans each with the single-page engine, and
returns an honest **site-level aggregate** (30/70 site-vs-page ESTIMATE score,
per-page mean/median/spread, block distribution, coverage gap, sampled-page
list) as JSON plus a compact summary.

**This returns structural aggregates only — it does NOT dump full per-page
extracted text** (that would be enormous, and per-page `extractedContent` is
intentionally omitted). To read one page's `mainText` + `answerStructure`, call
`aeo_scan_url` on that URL.

Example call:

```json
{ "name": "aeo_scan_site", "arguments": { "url": "https://example.com/", "maxPages": 8 } }
```

Example summary (abridged):

```
AEO site scan: https://example.com
Pages scanned: 8 (cap 8, hard max 15); discovery source: sitemap
Site score (ESTIMATE from 7 counted pages): 71/100 (grade C)
Per-page (0-70 portion) spread: mean=48.2 median=49 stdev=5.1 min=39 max=54
Site-level (0-30 portion, judged once from https://example.com/): aiCrawlerAccess=22/22 llmsTxt=0/8
Answer-readiness (beta, structural, NOT quality): mean 58/100 over 7 pages
Coverage gap: 1 of 8 sampled pages an AI crawler could NOT access ...
Block distribution: HARD_BLOCK=1 SOFT_BLOCK=0 robotsDisallowed=0 metaNoindex=0

NOTE: Site scan reports STRUCTURAL AGGREGATES only...
```

---

## Honest notes

- **Answer-ability is the host LLM's judgement.** The engine surfaces
  `mainText` + `answerStructure`; it never scores whether an answer is correct,
  complete, or useful. Form that judgement yourself.
- **SSRF is secure by default.** Private / loopback / link-local / cloud-metadata
  hosts are blocked (entry URL **and** every redirect hop), reusing the core
  lib's single SSRF source of truth. To scan an internal host (e.g. a local dev
  server) you must opt in explicitly, either with `AEO_ALLOW_PRIVATE_HOSTS=1` in
  the environment or `allowPrivateHosts: true` in the tool arguments. When a host
  is blocked the error says so and names the env var.
- **No Turnstile / rate limit / circuit breaker.** Those live in the public
  Cloudflare Worker (a shared surface). This MCP server is a local,
  single-developer stdio process, so it keeps only the always-correct guards: an
  SSRF check and a per-fetch timeout + redirect cap.
- **Site scan is capped** at 15 pages (deterministic, section-aware sampling)
  and reports structural aggregates only.
- **Not on npm yet; repo not public yet** (Fase 5). Run from a local build; a
  published package + `npx` entry point will follow at launch.
