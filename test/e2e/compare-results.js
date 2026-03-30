#!/usr/bin/env node

/**
 * Compare E2E test results from multiple models.
 *
 * Reads JSON result files from benchmark runs and produces a comparison
 * table showing pass rates, timing, and failure counts for each model.
 *
 * Usage:
 *   node test/e2e/compare-results.js results-*.json
 *   node test/e2e/compare-results.js --dir ./benchmark-results/
 *
 * Output:
 *   Prints a formatted table to stdout with:
 *   - Model name
 *   - Pass rate (passed/total)
 *   - Average time
 *   - Failure count
 *
 * Dependencies: node:fs, node:path
 * Depended on by: scripts/update-benchmark-readme.js (indirect)
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

// Eval saturation detection
// Per Anthropic's eval guide: capability evals with >80% pass rate across
// all models have lost improvement signal and should become regression evals.
const saturationThreshold = 0.8;
const saturatedScenarios = Array.from(allScenarios).filter((name) => {
  const scores = results.map((r) => {
    const s = r.results.find((s) => s.name === name);
    return s ? s.score : 0;
  });
  const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
  return avgScore >= saturationThreshold;
});

if (saturatedScenarios.length > 0) {
  console.log("┌────────────────────────────────────────────────────────────────┐");
  console.log("│ ⚠ Eval Saturation Warning:                                   │");
  console.log("│ These evals have ≥80% avg score across all models.            │");
  console.log("│ They've lost improvement signal — consider promoting to       │");
  console.log("│ regression suite or replacing with harder variants.            │");
  console.log("└────────────────────────────────────────────────────────────────┘\n");

  for (const name of saturatedScenarios) {
    const scores = results.map((r) => {
      const s = r.results.find((s) => s.name === name);
      return s ? s.score : 0;
    });
    const avg = (scores.reduce((a, b) => a + b, 0) / scores.length * 100).toFixed(0);
    console.log(`  ⚠ ${name} (avg: ${avg}%)`);
  }
  console.log("");
}

// Reliability metrics (pass@k / pass^k)
const hasReliability = results.some((r) =>
  r.results.some((s) => s.reliability)
);

if (hasReliability) {
  console.log("┌────────────────────────────────────────────────────────────────┐");
  console.log("│ Reliability Metrics (pass@k / pass^k):                        │");
  console.log("│ pass@k = P(≥1 success in k trials)                            │");
  console.log("│ pass^k = P(all k trials succeed)                              │");
  console.log("└────────────────────────────────────────────────────────────────┘\n");

  console.log("  ┌─────────────────────┬──────────┬──────────┬──────────┐");
  console.log("  │ Model               │ Avg p@k  │ Avg p^k  │ Avg Rate │");
  console.log("  ├─────────────────────┼──────────┼──────────┼──────────┤");

  for (const r of results) {
    const withReliability = r.results.filter((s) => s.reliability);
    if (withReliability.length === 0) continue;
    const avgPassAtK = withReliability.reduce((s, sc) => s + sc.reliability.passAtK, 0) / withReliability.length;
    const avgPassHatK = withReliability.reduce((s, sc) => s + sc.reliability.passHatK, 0) / withReliability.length;
    const avgRate = withReliability.reduce((s, sc) => s + sc.reliability.passRate, 0) / withReliability.length;
    const model = r.model.padEnd(19);
    console.log(`  │ ${model} │  ${avgPassAtK.toFixed(3)}   │  ${avgPassHatK.toFixed(3)}   │  ${avgRate.toFixed(3)}   │`);
  }

  console.log("  └─────────────────────┴──────────┴──────────┴──────────┘\n");
}

// Token usage comparison
const hasTokenUsage = results.some((r) => r.aggregate.token_usage?.totalTokens > 0);

if (hasTokenUsage) {
  console.log("┌────────────────────────────────────────────────────────────────┐");
  console.log("│ Token Usage by Model:                                         │");
  console.log("└────────────────────────────────────────────────────────────────┘\n");

  for (const r of results) {
    const t = r.aggregate.token_usage;
    if (t && t.totalTokens > 0) {
      console.log(`  ${r.model}: ${t.totalTokens.toLocaleString()} tokens (${t.promptTokens.toLocaleString()} prompt, ${t.completionTokens.toLocaleString()} completion)`);
    }
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
console.log(`  Scenarios tested: ${allScenarios.size}`);
console.log(`  Saturated evals (≥80%): ${saturatedScenarios.length}/${allScenarios.size}\n`);
