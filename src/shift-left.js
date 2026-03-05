import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { logger } from "./logger.js";

/**
 * Shift-left feedback — inspired by Stripe's Minions.
 *
 * After file modifications, automatically run fast linting/validation to catch
 * errors before the model proceeds.  This "shifts feedback left" — surfacing
 * issues in seconds rather than waiting for a full test run.
 *
 * Design:
 *   - Detects project-specific lint commands from config files
 *   - Runs linters with a short timeout (10s) — fast feedback only
 *   - Returns structured results the agent can act on
 *   - Capped at MAX_LINT_ROUNDS per agent run to avoid infinite fix loops
 */

const MAX_LINT_ROUNDS = 2; // Stripe caps at 2 CI rounds — we do the same for lint

/**
 * Detect lint/check commands available in the project.
 * Returns an array of { name, command, timeout } objects.
 */
export function detectLintCommands(cwd) {
  const commands = [];

  // Node.js — check package.json scripts
  const pkgPath = path.join(cwd, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf-8"));
      const scripts = pkg.scripts || {};

      if (scripts.lint) {
        commands.push({ name: "lint", command: "npm run lint", timeout: 10_000 });
      }
      if (scripts["lint:fix"]) {
        commands.push({ name: "lint:fix", command: "npm run lint:fix", timeout: 10_000 });
      }
      if (scripts.typecheck || scripts["type-check"]) {
        const scriptName = scripts.typecheck ? "typecheck" : "type-check";
        commands.push({ name: "typecheck", command: `npm run ${scriptName}`, timeout: 15_000 });
      }
    } catch { /* malformed package.json */ }
  }

  // Python — common linters
  if (fs.existsSync(path.join(cwd, "pyproject.toml")) ||
      fs.existsSync(path.join(cwd, "setup.py"))) {
    // Check if ruff is configured (fast Python linter)
    if (fs.existsSync(path.join(cwd, "ruff.toml")) ||
        fs.existsSync(path.join(cwd, ".ruff.toml"))) {
      commands.push({ name: "ruff", command: "ruff check .", timeout: 10_000 });
    }

    // Fallback to pyproject.toml for tool configuration
    const pyprojectPath = path.join(cwd, "pyproject.toml");
    if (fs.existsSync(pyprojectPath)) {
      try {
        const content = fs.readFileSync(pyprojectPath, "utf-8");
        if (content.includes("[tool.ruff]")) {
          if (!commands.some(c => c.name === "ruff")) {
            commands.push({ name: "ruff", command: "ruff check .", timeout: 10_000 });
          }
        }
        if (content.includes("[tool.mypy]")) {
          commands.push({ name: "mypy", command: "mypy .", timeout: 15_000 });
        }
      } catch { /* unreadable */ }
    }
  }

  // Rust — cargo check is fast
  if (fs.existsSync(path.join(cwd, "Cargo.toml"))) {
    commands.push({ name: "cargo-check", command: "cargo check 2>&1", timeout: 30_000 });
  }

  // Go — go vet is fast
  if (fs.existsSync(path.join(cwd, "go.mod"))) {
    commands.push({ name: "go-vet", command: "go vet ./...", timeout: 15_000 });
  }

  return commands;
}

/**
 * Run a single lint command and return structured results.
 */
function runLintCommand({ name, command, timeout }, cwd) {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout, encoding: "utf-8", maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const output = ((stdout || "") + "\n" + (stderr || "")).trim();

      if (err) {
        resolve({
          name,
          command,
          passed: false,
          exitCode: err.code || 1,
          output: output.slice(0, 3000), // cap output size
        });
      } else {
        resolve({
          name,
          command,
          passed: true,
          exitCode: 0,
          output: output.slice(0, 500),
        });
      }
    });
  });
}

/**
 * Shift-left feedback controller.
 *
 * Tracks lint rounds per agent run and provides the lint-fix loop.
 */
export class ShiftLeftFeedback {
  constructor(cwd) {
    this.cwd = cwd;
    this.lintRounds = 0;
    this.lintCommands = null; // lazily detected
    this._lastModifiedFiles = new Set();
  }

  /** Reset round counter (call at start of each agent run). */
  reset() {
    this.lintRounds = 0;
    this._lastModifiedFiles = new Set();
  }

  /** Record that a file was modified. */
  trackModification(filePath) {
    this._lastModifiedFiles.add(filePath);
  }

  /** Whether we should run lint (have budget + have modified files). */
  shouldLint() {
    return this._lastModifiedFiles.size > 0 && this.lintRounds < MAX_LINT_ROUNDS;
  }

  /** Whether we've exhausted lint fix rounds. */
  get exhausted() {
    return this.lintRounds >= MAX_LINT_ROUNDS;
  }

  /**
   * Run available lint commands and return a feedback message.
   * Returns null if no lint commands are available or budget exhausted.
   */
  async runLint() {
    if (this.lintRounds >= MAX_LINT_ROUNDS) {
      logger.info(`Shift-left: lint budget exhausted (${MAX_LINT_ROUNDS} rounds used)`);
      return null;
    }

    // Lazy detection of lint commands
    if (this.lintCommands === null) {
      this.lintCommands = detectLintCommands(this.cwd);
      if (this.lintCommands.length > 0) {
        logger.info(`Shift-left: detected lint commands: ${this.lintCommands.map(c => c.name).join(", ")}`);
      } else {
        logger.debug("Shift-left: no lint commands detected");
      }
    }

    if (this.lintCommands.length === 0) {
      return null;
    }

    this.lintRounds++;
    logger.info(`Shift-left: running lint round ${this.lintRounds}/${MAX_LINT_ROUNDS}`);

    // Run only the first available lint command (keep it fast)
    const cmd = this.lintCommands[0];
    const result = await runLintCommand(cmd, this.cwd);

    // Clear tracked modifications
    this._lastModifiedFiles = new Set();

    if (result.passed) {
      return {
        passed: true,
        message: `[Shift-left] ✓ ${result.name} passed (round ${this.lintRounds}/${MAX_LINT_ROUNDS})`,
        round: this.lintRounds,
      };
    }

    const remaining = MAX_LINT_ROUNDS - this.lintRounds;
    return {
      passed: false,
      message: `[Shift-left] ✗ ${result.name} failed (round ${this.lintRounds}/${MAX_LINT_ROUNDS}, ${remaining} fix attempt(s) remaining):\n${result.output}`,
      round: this.lintRounds,
      output: result.output,
    };
  }
}

export { MAX_LINT_ROUNDS };
