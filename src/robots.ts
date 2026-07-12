/**
 * Minimal robots.txt parser. Groups directives by user-agent and evaluates
 * whether a given path is allowed for a given agent using longest-match
 * precedence (the widely-adopted rule used by Google et al.).
 */

export interface RobotsGroup {
  agents: string[];
  allow: string[];
  disallow: string[];
}

export interface ParsedRobots {
  groups: RobotsGroup[];
  /** Sitemap URLs declared in robots.txt. */
  sitemaps: string[];
  /** Raw text (trimmed). */
  raw: string;
}

/** Parse robots.txt text into grouped directives. */
export function parseRobots(text: string): ParsedRobots {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let expectingAgent = false;

  const lines = text.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === "user-agent") {
      if (!expectingAgent || current === null) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
        expectingAgent = true;
      }
      current.agents.push(value.toLowerCase());
    } else if (field === "allow") {
      expectingAgent = false;
      if (current) current.allow.push(value);
    } else if (field === "disallow") {
      expectingAgent = false;
      if (current) current.disallow.push(value);
    } else if (field === "sitemap") {
      sitemaps.push(value);
    } else {
      expectingAgent = false;
    }
  }

  return { groups, sitemaps, raw: text.trim() };
}

/** Find the most specific group matching an agent (exact > *). */
function groupsForAgent(
  robots: ParsedRobots,
  agent: string,
): RobotsGroup[] {
  const agentLc = agent.toLowerCase();
  const exact = robots.groups.filter((g) =>
    g.agents.some((a) => a !== "*" && agentLc.includes(a)),
  );
  if (exact.length > 0) return exact;
  return robots.groups.filter((g) => g.agents.includes("*"));
}

/** Convert a robots pattern to a comparable match: returns match length or -1. */
function matchLength(pattern: string, path: string): number {
  if (pattern === "") return -1; // empty Disallow = allow-all, no match
  // Translate robots wildcards (* and $) to a regex.
  const hasEnd = pattern.endsWith("$");
  const core = hasEnd ? pattern.slice(0, -1) : pattern;
  const escaped = core
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  const re = new RegExp("^" + escaped + (hasEnd ? "$" : ""));
  if (re.test(path)) {
    // Specificity ~ literal length of the pattern (excluding wildcards).
    return core.replace(/\*/g, "").length;
  }
  return -1;
}

export interface AgentRuling {
  agent: string;
  allowed: boolean;
  /** Which rule decided it, for transparency. */
  rule: string;
  /** True if there was any explicit group (exact match) for this agent. */
  hasExplicitGroup: boolean;
}

/**
 * Is `path` allowed for `agent`? Longest-match wins; Allow beats Disallow on
 * ties. No matching Disallow means allowed.
 */
export function isAllowed(
  robots: ParsedRobots,
  agent: string,
  path: string,
): AgentRuling {
  const agentLc = agent.toLowerCase();
  const hasExplicitGroup = robots.groups.some((g) =>
    g.agents.some((a) => a !== "*" && agentLc.includes(a)),
  );

  const groups = groupsForAgent(robots, agent);
  if (groups.length === 0) {
    return { agent, allowed: true, rule: "no matching group", hasExplicitGroup };
  }

  let bestAllow = -1;
  let bestDisallow = -1;
  let allowRule = "";
  let disallowRule = "";

  for (const g of groups) {
    for (const p of g.allow) {
      const len = matchLength(p, path);
      if (len > bestAllow) {
        bestAllow = len;
        allowRule = `Allow: ${p}`;
      }
    }
    for (const p of g.disallow) {
      const len = matchLength(p, path);
      if (len > bestDisallow) {
        bestDisallow = len;
        disallowRule = `Disallow: ${p}`;
      }
    }
  }

  if (bestDisallow === -1) {
    return { agent, allowed: true, rule: "no matching Disallow", hasExplicitGroup };
  }
  if (bestAllow >= bestDisallow) {
    return { agent, allowed: true, rule: allowRule || "Allow ties Disallow", hasExplicitGroup };
  }
  return { agent, allowed: false, rule: disallowRule, hasExplicitGroup };
}
