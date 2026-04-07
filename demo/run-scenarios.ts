#!/usr/bin/env tsx
// Moral Sentry - Demo: Run all example scenarios through the calculus
// This script does NOT require OpenClaw to be running.
// It loads the pre-built ImpactAssessments from example-json/ and feeds them
// directly through the calculus bridge, printing an audit result for each.
//
// For live assessment via the hosted API run with MORAL_SENTRY_API_KEY set, or
// omit it to use the shared (rate-limited) anonymous tier.
//
// Usage:  npx tsx demo/run-scenarios.ts
//         npm run demo

import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { runCalculus } from "../src/calculus.js";
import {
  DEFAULT_FACETS,
  DEFAULT_PRIORITY_WEIGHTS,
  LOW_DIVERGENCE_THRESHOLD,
  HIGH_DIVERGENCE_THRESHOLD,
} from "../src/defaults.js";
import { HostedAssessor } from "../src/hosted-assessor.js";
import type { ImpactAssessment, Facet, FacetRange } from "../src/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const examplesDir = join(__dirname, "..", "example-json");

// Example-json files use the flat { facet_name: { min, likely, max } } format
// for human readability. Convert to the structured ImpactAssessment type.
interface FlatAssessment {
  [facet: string]: { min: number; likely: number; max: number };
}

interface ScenarioFile {
  raw_intent: string;
  tool_used: string;
  impact_assessment: FlatAssessment;
}

function toImpactAssessment(
  flat: FlatAssessment,
  facets: Facet[],
): ImpactAssessment {
  const facetMap = new Map(facets.map((f) => [f.name, f]));
  const facetRanges: FacetRange[] = Object.entries(flat).map(
    ([name, range]) => ({
      facet: facetMap.get(name) ?? { name, description: name },
      ...range,
    }),
  );
  return { facetRanges };
}

const scenarios = [
  "nuclear-email.json",
  "leaky-summary.json",
  "vengeful-scheming.json",
  "force-push.json",
];

const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";

function outcomeLabel(audit: ReturnType<typeof runCalculus>): string {
  const { prescribed, divergence } = audit;
  if (divergence >= HIGH_DIVERGENCE_THRESHOLD)
    return `${RED}${BOLD}BLOCK${RESET}`;
  if (prescribed === "defer" || divergence >= LOW_DIVERGENCE_THRESHOLD)
    return `${YELLOW}${BOLD}ESCALATE (requires approval)${RESET}`;
  return `${GREEN}${BOLD}ALLOW${RESET}`;
}

function bar(value: number, width = 20): string {
  const normalized = (value + 1) / 2;
  const filled = Math.round(normalized * width);
  const sign = value >= 0 ? "+" : "";
  return `[${"█".repeat(filled)}${"░".repeat(width - filled)}] ${sign}${value.toFixed(2)}`;
}

console.log(`${BOLD}━━━ Moral Sentry - Scenario Demo ━━━${RESET}\n`);
console.log(`Using DEFAULT priority weights:\n`);
for (const facet of DEFAULT_FACETS) {
  const w = DEFAULT_PRIORITY_WEIGHTS[facet.name] ?? 0.5;
  console.log(`  ${facet.name.padEnd(25)} ${bar(w * 2 - 1, 15)}`);
}
console.log();

for (const filename of scenarios) {
  const filePath = join(examplesDir, filename);
  let scenario: ScenarioFile;
  try {
    scenario = JSON.parse(readFileSync(filePath, "utf8")) as ScenarioFile;
  } catch {
    console.error(`  [skip] could not read ${filename}`);
    continue;
  }

  const assessment = toImpactAssessment(
    scenario.impact_assessment,
    DEFAULT_FACETS,
  );
  const audit = runCalculus(assessment, DEFAULT_PRIORITY_WEIGHTS);

  console.log(
    `${BOLD}┌─ ${filename.replace(".json", "").toUpperCase().replace(/-/g, " ")} ─${"─".repeat(Math.max(0, 42 - filename.length))}┐${RESET}`,
  );
  console.log(`│ Tool:       ${scenario.tool_used}`);
  console.log(
    `│ Intent:     ${scenario.raw_intent.slice(0, 72)}${scenario.raw_intent.length > 72 ? "…" : ""}`,
  );
  console.log(`│`);
  console.log(`│ ${BOLD}Impact Assessment (likely values):${RESET}`);
  for (const range of audit.facetRanges) {
    console.log(`│   ${range.facet.name.padEnd(25)} ${bar(range.likely)}`);
  }
  console.log(`│`);
  console.log(`│ ${BOLD}Calculus Result:${RESET}`);
  console.log(
    `│   Prescribed choice:   ${BOLD}${audit.prescribed.toUpperCase()}${RESET}`,
  );
  console.log(
    `│   Divergence score:    ${(audit.divergence * 100).toFixed(1)}%`,
  );
  console.log(`│   Execute valence:     ${audit.executeValence.toFixed(4)}`);
  console.log(`│   Defer valence:       ${audit.deferValence.toFixed(4)}`);
  console.log(`│`);
  console.log(`│ ${BOLD}Outcome:${RESET}            ${outcomeLabel(audit)}`);
  console.log(`└${"─".repeat(50)}┘\n`);
}

console.log(`${DIM}To run the live plugin (requires OpenClaw):${RESET}`);
console.log(`  openclaw plugins install .`);
console.log(`  openclaw start\n`);
console.log(`${DIM}For live assessment via the hosted API:${RESET}`);
console.log(`  MORAL_SENTRY_API_KEY=<your-key> npm run demo`);
console.log(`  (omit the key to use the rate-limited anonymous tier)\n`);
