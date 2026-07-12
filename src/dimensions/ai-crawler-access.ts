/**
 * Dimension 1 — AI Crawler Access (weight 22).
 *
 * Parses robots.txt for the locked AI-bot list, reads X-Robots-Tag response
 * header and the page <meta name="robots"> for noindex/noai/nosnippet.
 * This is the gate: if AI bots are blocked, content cannot be ingested/cited.
 */

import { AI_BOTS } from "../constants.js";
import { DIMENSION_WEIGHTS, DIMENSION_LABELS } from "../types.js";
import { isAllowed } from "../robots.js";
import type { AnalysisContext } from "../context.js";
import type { DimensionResult, Finding } from "../types.js";

const MAX = DIMENSION_WEIGHTS.aiCrawlerAccess; // 22

export function scoreAiCrawlerAccess(ctx: AnalysisContext): DimensionResult {
  const findings: Finding[] = [];
  const signals: Record<string, unknown> = {};

  // Split the weight: 16 for robots.txt access, 6 for meta / header directives.
  const robotsCap = 16;
  const metaCap = 6;

  // --- robots.txt evaluation ---
  let robotsScore: number;
  const perBot: Record<string, { allowed: boolean; rule: string }> = {};

  if (!ctx.robotsFetched || ctx.robots === null) {
    // No robots.txt found => nothing disallowed => AI bots may crawl.
    robotsScore = robotsCap;
    signals.robotsTxt = "absent_or_unreachable";
    findings.push({
      code: "robots.absent",
      message:
        "No robots.txt was found, so AI crawlers are not disallowed by robots rules.",
      severity: "info",
      positive: true,
    });
  } else {
    let allowedCount = 0;
    const blocked: string[] = [];
    for (const bot of AI_BOTS) {
      const ruling = isAllowed(ctx.robots, bot, ctx.path || "/");
      perBot[bot] = { allowed: ruling.allowed, rule: ruling.rule };
      if (ruling.allowed) allowedCount++;
      else blocked.push(bot);
    }
    signals.aiBotsChecked = AI_BOTS.length;
    signals.aiBotsAllowed = allowedCount;
    signals.aiBotsBlocked = blocked;
    signals.perBot = perBot;

    const ratio = allowedCount / AI_BOTS.length;
    robotsScore = Math.round(ratio * robotsCap);

    if (blocked.length === 0) {
      findings.push({
        code: "robots.all_allowed",
        message: `All ${AI_BOTS.length} tracked AI crawlers are allowed by robots.txt.`,
        severity: "info",
        positive: true,
      });
    } else {
      const notable = blocked.filter((b) =>
        ["GPTBot", "OAI-SearchBot", "ClaudeBot", "PerplexityBot", "Google-Extended"].includes(b),
      );
      findings.push({
        code: "robots.some_blocked",
        message: `${blocked.length} of ${AI_BOTS.length} AI crawlers are disallowed by robots.txt (${blocked.slice(0, 6).join(", ")}${blocked.length > 6 ? ", …" : ""}).`,
        severity: notable.length > 0 ? "high" : "medium",
        positive: false,
      });
    }
  }

  // --- meta robots + X-Robots-Tag ---
  let metaScore = metaCap;
  const xRobots = (ctx.page.headers["x-robots-tag"] ?? "").toLowerCase();
  const metaRobotsEl = ctx.parsed.root.querySelector('meta[name="robots" i]');
  const metaRobots = (metaRobotsEl?.getAttribute("content") ?? "").toLowerCase();
  const combined = `${xRobots} ${metaRobots}`;

  signals.xRobotsTag = xRobots || null;
  signals.metaRobots = metaRobots || null;

  const directives = {
    noindex: /\bnoindex\b/.test(combined),
    noai: /\bnoai\b/.test(combined),
    noimageai: /\bnoimageai\b/.test(combined),
    nosnippet: /\bnosnippet\b/.test(combined),
    none: /\bnone\b/.test(combined),
  };
  signals.directives = directives;

  if (directives.noindex || directives.none) {
    metaScore -= 4;
    findings.push({
      code: "meta.noindex",
      message:
        "A noindex directive is set (meta robots or X-Robots-Tag), which discourages indexing and AI ingestion of this page.",
      severity: "high",
      positive: false,
    });
  }
  if (directives.noai || directives.none) {
    metaScore -= 1;
    findings.push({
      code: "meta.noai",
      message: "A noai directive asks AI models not to use this content.",
      severity: "medium",
      positive: false,
    });
  }
  if (directives.nosnippet) {
    metaScore -= 1;
    findings.push({
      code: "meta.nosnippet",
      message: "A nosnippet directive prevents text snippets from being shown.",
      severity: "low",
      positive: false,
    });
  }
  if (!directives.noindex && !directives.noai && !directives.nosnippet && !directives.none) {
    findings.push({
      code: "meta.clean",
      message: "No restrictive robots/AI meta directives detected on the page.",
      severity: "info",
      positive: true,
    });
  }
  metaScore = Math.max(0, metaScore);

  const score = Math.max(0, Math.min(MAX, robotsScore + metaScore));

  return {
    id: "aiCrawlerAccess",
    label: DIMENSION_LABELS.aiCrawlerAccess,
    score,
    max: MAX,
    signals,
    findings,
  };
}
