#!/usr/bin/env node

/**
 * E2E test runner — sequential orchestrator with JSON output, retry, and filtering.
 *
 * Runs all E2E test scenarios in sequence, collects results, and outputs
 * a summary. Supports filtering by scenario name, JSON output for CI,
 * and retry logic for flaky tests.
 *
 * Inspired by Anthropic's "Demystifying Evals for AI Agents":
 *   - pass@k / pass^k reliability metrics for non-determinism
 *   - Capability vs regression eval categorization
 *   - Token usage tracking per scenario
 *   - Eval saturation warnings
 *   - Transcript saving for post-mortem review
 *
 * Usage:
 *   node test/e2e/runner.js                    # human-readable to stdout
 *   node test/e2e/runner.js --json             # JSON to stdout, progress to stderr
 *   node test/e2e/runner.js --filter file-read # run only matching scenarios
 *   node test/e2e/runner.js --no-retry         # single attempt per scenario
 *   node test/e2e/runner.js --verbose          # include conversation dump on failure
 *   node test/e2e/runner.js --save-transcripts # save full transcripts to disk
 *
 * Dependencies: node:fs, node:path, node:child_process, ollama, ./config.js
 * Depended on by: npm run test:e2e, test/e2e/compare-results.js (indirect)
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { Ollama } from "ollama";
import { config } from "./config.js";

const args = process.argv.slice(2);
const JSON_MODE = args.includes("--json");
const NO_RETRY = args.includes("--no-retry");
const _VERBOSE = args.includes("--verbose");
const SAVE_TRANSCRIPTS = args.includes("--save-transcripts");
const FILTER = (() => {
  const idx = args.indexOf("--filter");
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  // Support env var for npm run: npm run test:e2e --filter=33
  // npm exposes --flag=value as npm_config_filter
  if (process.env.npm_config_filter) return process.env.npm_config_filter;
  if (process.env.SMOL_TEST_FILTER) return process.env.SMOL_TEST_FILTER;
  return null;
})();

// In JSON mode, human output goes to stderr so stdout is clean JSON.
// In normal mode, everything goes to stdout.
const log = JSON_MODE
  ? (...a) => process.stderr.write(a.join(" ") + "\n")
  : (...a) => process.stdout.write(a.join(" ") + "\n");

// ── Prerequisite check ───────────────────────────────────────────────

async function checkPrerequisites() {
  log(`\nChecking prerequisites...`);
  log(`  Model:  ${config.model}`);
  log(`  Host:   ${config.host}`);

  const client = new Ollama({ host: config.host });
  try {
    const list = await client.list();
    const models = list.models.map((m) => m.name);
    const modelBase = config.model.split(":")[0];
    const found = models.some(
      (m) => m === config.model || m.startsWith(modelBase + ":"),
    );
    if (!found) {
      log(`  ERROR: Model "${config.model}" not found.`);
      log(`  Available: ${models.join(", ")}`);
      log(`  Run: ollama pull ${config.model}`);
      process.exit(1);
    }
    log(`  Model available.`);
  } catch (err) {
    log(`  ERROR: Cannot connect to Ollama at ${config.host}`);
    log(`  ${err.message}`);
    log(`  Make sure Ollama is running: ollama serve`);
    process.exit(1);
  }

  const retries = NO_RETRY ? 1 : config.retries;
  log(`  Retries: ${retries}  |  Context: ${config.contextSize}  |  Max iter: ${config.maxIterations}`);
  log("");
}

// ── Discover scenarios ───────────────────────────────────────────────

function discoverScenarios() {
  const scenariosDir = path.join(
    path.dirname(new URL(import.meta.url).pathname),
    "scenarios",
  );
  let files = fs.readdirSync(scenariosDir)
    .filter((f) => f.endsWith(".test.js"))
    .sort();

  if (FILTER) {
    files = files.filter((f) => f.includes(FILTER));
    if (files.length === 0) {
      log(`No scenarios matching filter "${FILTER}".`);
      process.exit(1);
    }
  }

  return files.map((f) => path.join(scenariosDir, f));
}

// ── Run with retries ─────────────────────────────────────────────────

async function runScenario(filePath) {
  const mod = await import(filePath);
  if (typeof mod.run !== "function") {
    return {
      name: path.basename(filePath, ".test.js"),
      score: 0, passed: false,
      error: "No run() export",
      attempts: [],
      meta: {},
    };
  }

  const name = mod.meta?.name || path.basename(filePath, ".test.js");
  const scenarioMeta = {
    category: mod.meta?.category || "uncategorized",
    evalType: mod.meta?.evalType || "capability",   // "capability" | "regression"
    difficulty: mod.meta?.difficulty || "medium",    // "simple" | "medium" | "complex"
  };

  const maxAttempts = NO_RETRY ? 1 : config.retries;
  let bestResult = null;
  const attempts = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptStart = Date.now();
    try {
      const result = await mod.run();
      const duration = Date.now() - attemptStart;
      const attemptData = {
        attempt,
        score: result.score,
        passed: result.passed,
        duration,
        tokenUsage: result.tokenUsage || null,
      };
      attempts.push(attemptData);

      // Save transcript if requested
      if (SAVE_TRANSCRIPTS && result.transcript) {
        saveTranscript(name, attempt, result.transcript);
      }

      if (!bestResult || result.score > bestResult.score) {
        bestResult = { ...result, attempts, meta: scenarioMeta };
      }
      if (result.passed) break;

      if (attempt < maxAttempts) {
        log(`    Attempt ${attempt}/${maxAttempts}: score ${result.score} — retrying...`);
      }
    } catch (err) {
      const duration = Date.now() - attemptStart;
      attempts.push({ attempt, score: 0, passed: false, duration, error: err.message });
      log(`    Attempt ${attempt}/${maxAttempts}: ERROR — ${err.message}`);

      if (!bestResult) {
        bestResult = { name, score: 0, passed: false, error: err.message, attempts, checks: [], meta: scenarioMeta };
      }
    }
  }

  // Compute pass@k and pass^k from attempts
  bestResult.reliability = computeReliability(attempts);

  return bestResult;
}

// ── Reliability metrics (pass@k / pass^k) ────────────────────────────

/**
 * Compute pass@k and pass^k reliability metrics from attempt data.
 *
 * pass@k: probability that at least 1 of k attempts succeeds.
 * pass^k: probability that ALL k attempts succeed.
 *
 * These metrics capture non-determinism in agent behavior.
 * See: anthropic.com/engineering/demystifying-evals-for-ai-agents
 */
function computeReliability(attempts) {
  const k = attempts.length;
  if (k === 0) return { passAtK: 0, passHatK: 0, k, passRate: 0 };

  const successes = attempts.filter(a => a.passed).length;
  const passRate = successes / k;

  // pass@k: 1 - (1 - passRate)^k (at least one success in k trials)
  const passAtK = 1 - Math.pow(1 - passRate, k);

  // pass^k: passRate^k (all k trials succeed)
  const passHatK = Math.pow(passRate, k);

  return {
    passAtK: Math.round(passAtK * 1000) / 1000,
    passHatK: Math.round(passHatK * 1000) / 1000,
    k,
    passRate: Math.round(passRate * 1000) / 1000,
  };
}

// ── Transcript saving ────────────────────────────────────────────────

function saveTranscript(scenarioName, attempt, transcript) {
  try {
    const dir = path.join(process.cwd(), "test-transcripts");
    fs.mkdirSync(dir, { recursive: true });
    const filename = `${scenarioName}_attempt${attempt}_${Date.now()}.json`;
    fs.writeFileSync(
      path.join(dir, filename),
      JSON.stringify(transcript, null, 2),
    );
  } catch { /* best effort */ }
}

// ── Token usage aggregation ──────────────────────────────────────────

function aggregateTokenUsage(results) {
  let promptTokens = 0;
  let completionTokens = 0;

  for (const r of results) {
    for (const attempt of r.attempts || []) {
      if (attempt.tokenUsage) {
        promptTokens += attempt.tokenUsage.promptTokens || 0;
        completionTokens += attempt.tokenUsage.completionTokens || 0;
      }
    }
  }

  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
  };
}

// ── Main ─────────────────────────────────────────────────────────────

async function main() {
  await checkPrerequisites();

  const scenarios = discoverScenarios();
  log(`Running ${scenarios.length} scenario(s).\n`);

  let gitSha = "unknown";
  try {
    gitSha = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
  } catch { /* not a git repo */ }

  const results = [];
  const startTime = Date.now();

  for (const file of scenarios) {
    const basename = path.basename(file, ".test.js");
    log(`Running: ${basename} ...`);
    const scenarioStart = Date.now();

    const result = await runScenario(file);
    result.duration = Date.now() - scenarioStart;
    results.push(result);

    const icon = result.passed ? "\u2713" : "\u2717";
    const attemptCount = result.attempts?.length || 1;
    log(`  ${icon} ${result.name}: ${result.score} (${(result.duration / 1000).toFixed(1)}s, ${attemptCount} attempt(s))`);

    if (result.checks) {
      for (const c of result.checks) {
        const detail = c.actual !== undefined ? ` (got: ${JSON.stringify(c.actual).slice(0, 80)})` : "";
        log(`    ${c.passed ? "\u2713" : "\u2717"} ${c.name}${!c.passed ? detail : ""}`);
      }
    }

    if (result.error) {
      log(`    Error: ${result.error}`);
    }
    log("");
  }

  const totalDuration = Date.now() - startTime;
  const totalScore = results.reduce((s, r) => s + r.score, 0);
  const maxScore = results.length;
  const aggregate = maxScore > 0 ? Math.round((totalScore / maxScore) * 1000) / 1000 : 0;
  const passedCount = results.filter((r) => r.passed).length;

  // Aggregate token usage across all scenarios
  const totalTokens = aggregateTokenUsage(results);

  // Compute aggregate reliability metrics
  const allAttempts = results.flatMap(r => r.attempts || []);
  const avgPassRate = results.length > 0
    ? results.reduce((s, r) => s + (r.reliability?.passRate || 0), 0) / results.length
    : 0;

  // Detect eval saturation (blog: scenarios >80% should be flagged)
  const saturatedEvals = results.filter(r =>
    r.reliability && r.reliability.passRate >= 0.8 && r.meta?.evalType === "capability"
  );

  // Categorize results by eval type
  const capabilityResults = results.filter(r => r.meta?.evalType === "capability");
  const regressionResults = results.filter(r => r.meta?.evalType === "regression");

  log("═══════════════════════════════════════════");
  log(`Results: ${passedCount}/${results.length} passed`);
  log(`Aggregate score: ${aggregate} (${totalScore.toFixed(3)}/${maxScore})`);
  log(`Avg reliability (pass rate): ${(avgPassRate * 100).toFixed(1)}%`);
  if (totalTokens.totalTokens > 0) {
    log(`Token usage: ${totalTokens.totalTokens} total (${totalTokens.promptTokens} prompt, ${totalTokens.completionTokens} completion)`);
  }
  if (capabilityResults.length > 0 || regressionResults.length > 0) {
    const capPassed = capabilityResults.filter(r => r.passed).length;
    const regPassed = regressionResults.filter(r => r.passed).length;
    log(`Capability evals: ${capPassed}/${capabilityResults.length} | Regression evals: ${regPassed}/${regressionResults.length}`);
  }
  log(`Total duration: ${(totalDuration / 1000).toFixed(1)}s`);
  log(`Model: ${config.model}  |  Git: ${gitSha}`);
  log("═══════════════════════════════════════════");

  if (saturatedEvals.length > 0) {
    log("");
    log(`⚠ Eval saturation: ${saturatedEvals.length} capability eval(s) have ≥80% pass rate.`);
    log(`  Consider promoting to regression suite:`);
    for (const r of saturatedEvals) {
      log(`    - ${r.name} (pass rate: ${(r.reliability.passRate * 100).toFixed(0)}%)`);
    }
  }
  log("");

  if (JSON_MODE) {
    const output = {
      run_id: `e2e-${Date.now()}`,
      model: config.model,
      git_sha: gitSha,
      timestamp: new Date().toISOString(),
      config: {
        retries: NO_RETRY ? 1 : config.retries,
        contextSize: config.contextSize,
        maxIterations: config.maxIterations,
      },
      results: results.map(({ name, score, passed, duration, attempts, error, checks, reliability, meta }) => ({
        name, score, passed, duration,
        meta: meta || {},
        reliability: reliability || null,
        attempts: attempts || [],
        error: error || null,
        checks: (checks || []).map(({ name, passed, weight, actual }) => ({
          name, passed, weight,
          ...(actual !== undefined && { actual }),
        })),
      })),
      aggregate: {
        total_score: Math.round(totalScore * 1000) / 1000,
        max_score: maxScore,
        normalized: aggregate,
        passed: passedCount,
        total: results.length,
        avg_pass_rate: Math.round(avgPassRate * 1000) / 1000,
        token_usage: totalTokens,
        by_eval_type: {
          capability: {
            total: capabilityResults.length,
            passed: capabilityResults.filter(r => r.passed).length,
          },
          regression: {
            total: regressionResults.length,
            passed: regressionResults.filter(r => r.passed).length,
          },
        },
        saturated_evals: saturatedEvals.map(r => r.name),
      },
      duration: totalDuration,
    };
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
  }

  process.exit(passedCount === results.length ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err.message}\n${err.stack}\n`);
  process.exit(2);
});
