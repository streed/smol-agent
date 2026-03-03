#!/usr/bin/env node

/**
 * Compare E2E test results from multiple models
 *
 * Usage:
 *   node test/e2e/compare-results.js results-*.json
 *   node test/e2e/compare-results.js --dir ./benchmark-results/
 */

import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);

// Collect result files
let resultFiles = [];

if (args.includes("--dir")) {
  const dirIdx = args.indexOf("--dir");
  const dir = args[dirIdx + 1];
  if (!dir) {
    console.error("Error: --dir requires a directory path");
    process.exit(1);
  }
  resultFiles = fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => path.join(dir, f));
} else {
  resultFiles = args.filter((f) => f.endsWith(".json"));
}

if (resultFiles.length === 0) {
  console.error("Error: No result files provided");
  console.error("");
  console.error("Usage:");
  console.error("  node compare-results.js results-*.json");
  console.error("  node compare-results.js --dir ./benchmark-results/");
  process.exit(1);
}

// Load and parse results
const results = resultFiles.map((file) => {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      file: path.basename(file),
      model: data.model,
      aggregate: data.aggregate,
      results: data.results,
      timestamp: data.timestamp,
    };
  } catch (err) {
    console.error(`Error reading ${file}: ${err.message}`);
    return null;
  }
}).filter(Boolean);

if (results.length === 0) {
  console.error("Error: No valid result files found");
  process.exit(1);
}

// Sort by normalized score descending
results.sort((a, b) => b.aggregate.normalized - a.aggregate.normalized);

console.log("\n╔════════════════════════════════════════════════════════════════╗");
console.log("║           Model Benchmark Comparison Results                  ║");
console.log("╚════════════════════════════════════════════════════════════════╝\n");

// Overall comparison table
console.log("┌─────────────────────┬─────────┬────────┬───────┬──────────┐");
console.log("│ Model               │  Score  │ Passed │ Total │ Pass %   │");
console.log("├─────────────────────┼─────────┼────────┼───────┼──────────┤");

results.forEach((r, idx) => {
  const model = r.model.padEnd(19);
  const score = r.aggregate.normalized.toFixed(3);
  const passed = String(r.aggregate.passed).padStart(6);
  const total = String(r.aggregate.total).padStart(5);
  const passPercent = ((r.aggregate.passed / r.aggregate.total) * 100).toFixed(1);
  const badge = idx === 0 ? "🏆" : "  ";

  console.log(`│ ${badge} ${model} │ ${score} │${passed} │${total} │  ${passPercent.padStart(5)}% │`);
});

console.log("└─────────────────────┴─────────┴────────┴───────┴──────────┘\n");

// Find scenarios that failed for any model
const allScenarios = new Set();
results.forEach((r) => {
  r.results.forEach((scenario) => allScenarios.add(scenario.name));
});

const failedScenarios = Array.from(allScenarios).filter((name) => {
  return results.some((r) => {
    const scenario = r.results.find((s) => s.name === name);
    return scenario && !scenario.passed;
  });
});

if (failedScenarios.length > 0) {
  console.log("┌────────────────────────────────────────────────────────────────┐");
  console.log("│ Scenarios with failures across models:                        │");
  console.log("└────────────────────────────────────────────────────────────────┘\n");

  failedScenarios.forEach((scenarioName) => {
    console.log(`  📋 ${scenarioName}`);

    results.forEach((r) => {
      const scenario = r.results.find((s) => s.name === scenarioName);
      if (scenario) {
        const status = scenario.passed ? "✅" : "❌";
        const score = scenario.score.toFixed(2);
        const modelShort = r.model.padEnd(18);
        console.log(`     ${status} ${modelShort} ${score}`);
      }
    });

    console.log("");
  });
}

// Performance comparison
console.log("┌────────────────────────────────────────────────────────────────┐");
console.log("│ Best performing scenarios (all models passed):                │");
console.log("└────────────────────────────────────────────────────────────────┘\n");

const passedByAll = Array.from(allScenarios).filter((name) => {
  return results.every((r) => {
    const scenario = r.results.find((s) => s.name === name);
    return scenario && scenario.passed;
  });
});

if (passedByAll.length > 0) {
  console.log(`  ✨ ${passedByAll.length} scenarios passed by all models:`);
  passedByAll.slice(0, 10).forEach((name) => {
    console.log(`     • ${name}`);
  });
  if (passedByAll.length > 10) {
    console.log(`     ... and ${passedByAll.length - 10} more`);
  }
  console.log("");
}

// Summary stats
console.log("┌────────────────────────────────────────────────────────────────┐");
console.log("│ Summary Statistics:                                           │");
console.log("└────────────────────────────────────────────────────────────────┘\n");

const avgScore = results.reduce((sum, r) => sum + r.aggregate.normalized, 0) / results.length;
const totalTests = results.reduce((sum, r) => sum + r.aggregate.total, 0);
const totalPassed = results.reduce((sum, r) => sum + r.aggregate.passed, 0);

console.log(`  Average score across all models: ${avgScore.toFixed(3)}`);
console.log(`  Total test runs: ${totalTests}`);
console.log(`  Total passed: ${totalPassed} (${((totalPassed / totalTests) * 100).toFixed(1)}%)`);
console.log(`  Models compared: ${results.length}`);
console.log(`  Scenarios tested: ${allScenarios.size}\n`);
