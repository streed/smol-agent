#!/usr/bin/env node

/**
 * E2E test runner — sequential orchestrator with JSON output, retry, and filtering.
 *
 * Usage:
 *   node test/e2e/runner.js                    # human-readable to stdout
 *   node test/e2e/runner.js --json             # JSON to stdout, progress to stderr
 *   node test/e2e/runner.js --filter file-read # run only matching scenarios
 *   node test/e2e/runner.js --no-retry         # single attempt per scenario
 *   node test/e2e/runner.js --verbose          # include conversation dump on failure
 */

import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { Ollama } from "ollama";
import { config } from "./config.js";

const args = process.argv.slice(2);
const JSON_MODE = args.includes("--json");
const NO_RETRY = args.includes("--no-retry");
const VERBOSE = args.includes("--verbose");
const FILTER = (() => {
  const idx = args.indexOf("--filter");
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
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
    };
  }

  const name = mod.meta?.name || path.basename(filePath, ".test.js");
  const maxAttempts = NO_RETRY ? 1 : config.retries;
  let bestResult = null;
  const attempts = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const attemptStart = Date.now();
    try {
      const result = await mod.run();
      const duration = Date.now() - attemptStart;
      attempts.push({ attempt, score: result.score, passed: result.passed, duration });

      if (!bestResult || result.score > bestResult.score) {
        bestResult = { ...result, attempts };
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
        bestResult = { name, score: 0, passed: false, error: err.message, attempts, checks: [] };
      }
    }
  }

  return bestResult;
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

  log("═══════════════════════════════════════════");
  log(`Results: ${passedCount}/${results.length} passed`);
  log(`Aggregate score: ${aggregate} (${totalScore.toFixed(3)}/${maxScore})`);
  log(`Total duration: ${(totalDuration / 1000).toFixed(1)}s`);
  log(`Model: ${config.model}  |  Git: ${gitSha}`);
  log("═══════════════════════════════════════════");
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
      results: results.map(({ name, score, passed, duration, attempts, error, checks }) => ({
        name, score, passed, duration,
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
