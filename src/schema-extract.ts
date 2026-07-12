/**
 * Structured-data extraction. JSON-LD is the primary, first-class source
 * (parsed via JSON.parse). Microdata and RDFa are detected best-effort only
 * (presence + itemtype/typeof types), which is a documented limitation.
 */

import type { HTMLElement } from "node-html-parser";

export interface SchemaExtraction {
  /** All @type values found in valid JSON-LD (case preserved, deduped). */
  jsonLdTypes: string[];
  /** Number of <script type="application/ld+json"> blocks. */
  jsonLdBlockCount: number;
  /** Number of JSON-LD blocks that failed to parse. */
  jsonLdInvalidCount: number;
  /** Flattened JSON-LD nodes (objects that have an @type). */
  jsonLdNodes: Record<string, unknown>[];
  /** Best-effort microdata itemtype types (short names). */
  microdataTypes: string[];
  /** Best-effort RDFa typeof types (short names). */
  rdfaTypes: string[];
  /** True if any structured data of any kind was detected. */
  hasAny: boolean;
}

/** Reduce a schema.org type URI/name to its short type token. */
function shortType(t: string): string {
  const trimmed = t.trim();
  const slash = trimmed.split(/[/#]/).pop() ?? trimmed;
  return slash;
}

function collectTypes(
  node: unknown,
  out: Set<string>,
  nodes: Record<string, unknown>[],
): void {
  if (Array.isArray(node)) {
    for (const n of node) collectTypes(n, out, nodes);
    return;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    const t = obj["@type"];
    if (typeof t === "string") {
      out.add(shortType(t));
      nodes.push(obj);
    } else if (Array.isArray(t)) {
      for (const tt of t) if (typeof tt === "string") out.add(shortType(tt));
      nodes.push(obj);
    }
    // Recurse into @graph and nested values (e.g. author, publisher).
    for (const [k, v] of Object.entries(obj)) {
      if (k === "@type") continue;
      collectTypes(v, out, nodes);
    }
  }
}

export function extractSchema(root: HTMLElement): SchemaExtraction {
  const scripts = root.querySelectorAll(
    'script[type="application/ld+json"]',
  );

  const typeSet = new Set<string>();
  const nodes: Record<string, unknown>[] = [];
  let invalid = 0;

  for (const s of scripts) {
    const raw = s.rawText || s.innerText || s.textContent || "";
    const text = raw.trim();
    if (!text) continue;
    try {
      const parsed = JSON.parse(text);
      collectTypes(parsed, typeSet, nodes);
    } catch {
      invalid++;
    }
  }

  // Best-effort microdata.
  const microSet = new Set<string>();
  for (const el of root.querySelectorAll("[itemtype]")) {
    const it = el.getAttribute("itemtype");
    if (it) microSet.add(shortType(it));
  }

  // Best-effort RDFa.
  const rdfaSet = new Set<string>();
  for (const el of root.querySelectorAll("[typeof]")) {
    const tv = el.getAttribute("typeof");
    if (tv) for (const part of tv.split(/\s+/)) if (part) rdfaSet.add(shortType(part));
  }

  const jsonLdTypes = [...typeSet];
  const microdataTypes = [...microSet];
  const rdfaTypes = [...rdfaSet];

  return {
    jsonLdTypes,
    jsonLdBlockCount: scripts.length,
    jsonLdInvalidCount: invalid,
    jsonLdNodes: nodes,
    microdataTypes,
    rdfaTypes,
    hasAny:
      jsonLdTypes.length > 0 ||
      microdataTypes.length > 0 ||
      rdfaTypes.length > 0,
  };
}

/** True if any of `wanted` appears in `have` (case-insensitive). */
export function hasType(have: string[], wanted: readonly string[]): boolean {
  const lower = new Set(have.map((h) => h.toLowerCase()));
  return wanted.some((w) => lower.has(w.toLowerCase()));
}

/** Return the subset of `wanted` present in `have` (case-insensitive). */
export function matchedTypes(
  have: string[],
  wanted: readonly string[],
): string[] {
  const lower = new Set(have.map((h) => h.toLowerCase()));
  return wanted.filter((w) => lower.has(w.toLowerCase()));
}

/** Find first JSON-LD node whose @type matches one of the given types. */
export function findNode(
  nodes: Record<string, unknown>[],
  types: readonly string[],
): Record<string, unknown> | null {
  const want = new Set(types.map((t) => t.toLowerCase()));
  for (const n of nodes) {
    const t = n["@type"];
    if (typeof t === "string" && want.has(shortType(t).toLowerCase())) return n;
    if (Array.isArray(t)) {
      for (const tt of t)
        if (typeof tt === "string" && want.has(shortType(tt).toLowerCase()))
          return n;
    }
  }
  return null;
}
