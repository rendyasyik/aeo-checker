# aeo-checker

Deterministic on-page **AEO / AI-readiness checker**. It fetches a page's **raw HTML (no JavaScript rendering)** and scores how ready that page is to be read, understood, and cited by AI crawlers and answer engines.

The core library is **runtime-agnostic** (global `fetch` + Web-standard APIs only), so the same engine can run in a Cloudflare Worker (web tool), in Node (MCP server), or in tests.

## Why raw HTML, no JS render

AI crawlers generally do **not** execute JavaScript. If your content only appears after client-side hydration, the crawler sees an empty shell. This tool deliberately mirrors what an AI crawler actually sees, and reports honestly when a page is blocked or JS-gated.

## Honesty as a feature

Every URL is classified as:

- `OK` — reachable and readable.
- `HARD_BLOCK` — 401 / 403 / 429 / 503 / bot-challenge; the crawler cannot fetch it.
- `SOFT_BLOCK` — HTTP 200 but the content is effectively invisible: login/paywall gate, or a JS-only shell with almost no rendered text.

## Scoring

Deterministic, published weights. **100-point core** across six dimensions:

| Dimension | Weight |
|---|---:|
| AI Crawler Access (robots.txt + meta / X-Robots-Tag) | 22 |
| Content Extractability without JS | 22 |
| Structured Data / Schema.org | 20 |
| Semantic Content Structure | 16 |
| Metadata & Identity / Provenance | 12 |
| llms.txt discoverability | 8 |
| **Total** | **100** |

An **Answer-readiness (beta)** sub-score is reported **separately, outside the 100-point core** — a cheap structural proxy (no LLM). Full answer-ability lives in the MCP server.

## Usage (library)

```ts
import { analyzeUrl } from "aeo-checker";

const report = await analyzeUrl("https://example.com/");
console.log(report.total, report.grade);
```

## CLI test harness

```bash
npm run scan -- https://example.com/
```

Prints score + per-dimension breakdown + block report in a readable form. (Node-only harness; the core in `src/` stays runtime-agnostic.)

## License

License to follow. A permissive license (MIT) will be added when this repository is made public. Until then: all rights reserved.

---

Built by **Rendy & Co.**
