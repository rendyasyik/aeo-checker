/**
 * CLI test harness (Node-only). Runs the engine against one or more live URLs
 * and prints a readable score + per-dimension breakdown + block report.
 *
 *   npm run scan -- https://example.com/ [https://another.com/ ...]
 *
 * This file may use Node APIs; the core in src/ stays runtime-agnostic.
 */

import { analyzeUrl } from "../src/index.js";
import type { AeoReport } from "../src/index.js";

const BLOCK_LABEL: Record<string, string> = {
  OK: "OK",
  HARD_BLOCK: "HARD BLOCK",
  SOFT_BLOCK: "SOFT BLOCK",
};

function bar(score: number, max: number, width = 20): string {
  const filled = max > 0 ? Math.round((score / max) * width) : 0;
  return "#".repeat(filled) + "-".repeat(Math.max(0, width - filled));
}

function printReport(report: AeoReport): void {
  const line = "=".repeat(72);
  console.log(line);
  console.log(`URL:        ${report.url}`);
  if (report.finalUrl !== report.url) console.log(`Final URL:  ${report.finalUrl}`);
  console.log(`Block:      ${BLOCK_LABEL[report.block.status]} (${report.block.reason})`);
  console.log(`            ${report.block.detail}`);
  console.log(line);
  console.log(`TOTAL:      ${report.total}/100   Grade: ${report.grade}`);
  console.log(
    `Answer-readiness (beta, separate): ${report.answerReadinessBeta.score}/100  Grade ${report.answerReadinessBeta.grade}`,
  );
  console.log("-".repeat(72));
  console.log("Dimension breakdown:");
  for (const d of Object.values(report.dimensions)) {
    console.log(
      `  ${d.label.padEnd(38)} ${String(d.score).padStart(2)}/${String(d.max).padStart(2)}  [${bar(d.score, d.max)}]`,
    );
  }
  console.log("-".repeat(72));
  console.log("Top fixes (impact-first):");
  const top = report.fixes.slice(0, 6);
  if (top.length === 0) {
    console.log("  (none — nothing flagged)");
  } else {
    for (const f of top) {
      console.log(`  [+${f.impact.toFixed(1)} | ${f.severity}] ${f.message}`);
    }
  }
  if (report.notes.length > 0) {
    console.log("-".repeat(72));
    console.log("Notes:");
    for (const n of report.notes) console.log(`  - ${n}`);
  }
  console.log(line);
  console.log("");
}

async function main(): Promise<void> {
  const urls = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (urls.length === 0) {
    console.error("Usage: npm run scan -- <url> [<url> ...]");
    process.exit(1);
  }
  for (const url of urls) {
    try {
      const report = await analyzeUrl(url, { timeoutMs: 20000 });
      printReport(report);
    } catch (e) {
      console.error(`Failed to analyze ${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

void main();
