#!/usr/bin/env node

/**
 * Update README.md with benchmark results table.
 *
 * Reads a benchmark-data.json file and replaces the content between
 * <!-- BENCHMARK-RESULTS-START --> and <!-- BENCHMARK-RESULTS-END -->
 * markers in README.md with a markdown table of results.
 *
 * Usage:
 *   node scripts/update-benchmark-readme.js --input benchmark-data.json
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const START_MARKER = "<!-- BENCHMARK-RESULTS-START -->";
const END_MARKER = "<!-- BENCHMARK-RESULTS-END -->";

function generateTable(data) {
  const dateStr = new Date(data.date).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  const lines = [];

  lines.push(`> **Run #${data.runNumber}** | ${dateStr} | \`${data.sha}\` | **${data.conclusion.toUpperCase()}**`);
  lines.push("");
  lines.push("| Model | Status | Passed | Total | Score |");
  lines.push("|-------|--------|--------|-------|-------|");

  for (const model of data.models) {
    const status = model.status === "pass" ? "PASS" : model.status === "error" ? "ERROR" : "FAIL";
    const icon = model.status === "pass" ? "+" : model.status === "error" ? "!" : "-";
    const pct = model.total > 0 ? Math.round((model.passed / model.total) * 100) : 0;
    lines.push(`| ${model.name} | ${icon} ${status} | ${model.passed} | ${model.total} | ${pct}% |`);
  }

  if (data.summary) {
    lines.push("");
    lines.push(`**AI Analysis (glm-5):** ${data.summary}`);
  }

  return lines.join("\n");
}

function main() {
  const inputFlagIndex = process.argv.indexOf("--input");
  if (inputFlagIndex === -1 || !process.argv[inputFlagIndex + 1]) {
    console.error("Usage: node scripts/update-benchmark-readme.js --input <benchmark-data.json>");
    process.exit(1);
  }
  const inputFile = process.argv[inputFlagIndex + 1];

  let data;
  try {
    data = JSON.parse(fs.readFileSync(inputFile, "utf8"));
  } catch (err) {
    console.error(`Failed to read benchmark data from ${inputFile}: ${err.message}`);
    process.exit(1);
  }

  const readmePath = path.join(__dirname, "..", "README.md");
  let readme;
  try {
    readme = fs.readFileSync(readmePath, "utf8");
  } catch (err) {
    console.error(`Failed to read README.md: ${err.message}`);
    process.exit(1);
  }

  const startIdx = readme.indexOf(START_MARKER);
  const endIdx = readme.indexOf(END_MARKER);

  if (startIdx === -1 || endIdx === -1) {
    console.error("Could not find benchmark result markers in README.md");
    console.error(`Expected: ${START_MARKER} ... ${END_MARKER}`);
    process.exit(1);
  }

  const table = generateTable(data);
  const updated =
    readme.substring(0, startIdx + START_MARKER.length) +
    "\n" +
    table +
    "\n" +
    readme.substring(endIdx);

  fs.writeFileSync(readmePath, updated);
  console.log(`Updated README.md with benchmark results for ${data.models.length} models`);
}

main();
