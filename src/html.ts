/**
 * HTML parsing helpers built on node-html-parser (lightweight, runs in both
 * Cloudflare Workers and Node). Provides a parsed document plus derived text
 * metrics reused across dimensions and block detection.
 */

import { parse, HTMLElement } from "node-html-parser";

export interface ParsedHtml {
  root: HTMLElement;
  /** Full raw HTML length in characters. */
  htmlLength: number;
  /** Visible text (scripts/styles removed), collapsed whitespace. */
  visibleText: string;
  /** Word count of visible text. */
  wordCount: number;
  /** Ratio of visible text length to raw HTML length (0-1). */
  textToHtmlRatio: number;
  /** Text length inside <main>/<article> if present, else 0. */
  mainText: string;
  mainWordCount: number;
  /** Number of <script> tags. */
  scriptCount: number;
  /** Approx total bytes of inline + referenced script markup. */
  scriptMarkupLength: number;
}

const BLOCK_LEVEL_TAGS = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "header",
  "footer",
  "li",
  "tr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "br",
]);

function collapseWs(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function countWords(s: string): number {
  const t = s.trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

/** Parse raw HTML and compute reusable text metrics. */
export function parseHtml(html: string): ParsedHtml {
  const root = parse(html, {
    lowerCaseTagName: true,
    comment: false,
    // Preserve raw text of script/style so JSON-LD can be read back. Our own
    // extractText() explicitly skips these tags, so they never leak into
    // visible text.
    blockTextElements: {
      script: true,
      noscript: true,
      style: true,
      pre: true,
    },
  });

  const scripts = root.querySelectorAll("script");

  let scriptMarkupLength = 0;
  for (const s of scripts) scriptMarkupLength += s.outerHTML.length;

  // Build visible text from the body, ignoring script/style/noscript nodes.
  const body = root.querySelector("body") ?? root;

  const extractText = (el: HTMLElement): string => {
    const tag = el.rawTagName?.toLowerCase();
    if (tag === "script" || tag === "style" || tag === "noscript") return "";
    let out = "";
    for (const child of el.childNodes) {
      // Node type 3 = text node in node-html-parser.
      if ((child as { nodeType?: number }).nodeType === 3) {
        out += (child as { text: string }).text;
      } else if (child instanceof HTMLElement) {
        const inner = extractText(child);
        if (inner) {
          const t = child.rawTagName?.toLowerCase();
          out += (t && BLOCK_LEVEL_TAGS.has(t) ? " " : "") + inner + " ";
        }
      }
    }
    return out;
  };

  const visibleTextRaw = extractText(body);
  const visibleText = collapseWs(visibleTextRaw);
  const wordCount = countWords(visibleText);
  const htmlLength = html.length;

  // Prefer <main>; fall back to <article> only when no <main> exists. This
  // avoids double-counting an <article> nested inside <main>.
  const mainEls = root.querySelectorAll("main");
  const landmarkEls =
    mainEls.length > 0 ? mainEls : root.querySelectorAll("article");
  let mainTextRaw = "";
  for (const m of landmarkEls) mainTextRaw += " " + extractText(m);
  const mainText = collapseWs(mainTextRaw);
  const mainWordCount = countWords(mainText);

  const textToHtmlRatio = htmlLength > 0 ? visibleText.length / htmlLength : 0;

  return {
    root,
    htmlLength,
    visibleText,
    wordCount,
    textToHtmlRatio,
    mainText,
    mainWordCount,
    scriptCount: scripts.length,
    scriptMarkupLength,
  };
}
