/**
 * E2E test: Fix failing test suite.
 *
 * Scenario: A Calculator implementation with buggy modulo() method,
 * and a test suite that fails due to the bug. Agent must:
 * 1. Run the tests to see failures
 * 2. Identify the bug in modulo()
 * 3. Fix the implementation
 * 4. Verify tests pass
 *
 * Dependencies: ../config.js, assert, ./calculator
 */
import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "fix-failing-test", timeout: config.timeouts.complex, category: "debugging", evalType: "capability", difficulty: "complex" };

const SEED_IMPL = `class Calculator {
  add(a, b) {
    return a + b;
  }

  subtract(a, b) {
    return a - b;
  }

  multiply(a, b) {
    return a * b;
  }

  divide(a, b) {
    if (b === 0) throw new Error("Division by zero");
    return Math.floor(a / b);
  }

  modulo(a, b) {
    if (b === 0) throw new Error("Division by zero");
    let result = a;
    while (result >= b) {
      result = result - b;
    }
    return result;
  }
}

module.exports = { Calculator };
`;

const SEED_TEST = `const assert = require("assert");
const { Calculator } = require("./calculator");

const calc = new Calculator();

// --- add ---
assert.strictEqual(calc.add(2, 3), 5, "2 + 3 = 5");
assert.strictEqual(calc.add(-1, 1), 0, "-1 + 1 = 0");

// --- subtract ---
assert.strictEqual(calc.subtract(10, 4), 6, "10 - 4 = 6");

// --- multiply ---
assert.strictEqual(calc.multiply(3, 4), 12, "3 * 4 = 12");

// --- divide ---
assert.strictEqual(calc.divide(10, 3), 10 / 3, "10 / 3 should be ~3.333");
assert.strictEqual(calc.divide(7, 2), 3.5, "7 / 2 = 3.5");

// --- modulo ---
assert.strictEqual(calc.modulo(10, 3), 1, "10 % 3 = 1");
assert.strictEqual(calc.modulo(7, 4), 3, "7 % 4 = 3");
assert.strictEqual(calc.modulo(5, 5), 0, "5 % 5 = 0");

// --- divide by zero ---
assert.throws(() => calc.divide(1, 0), /Division by zero/);
assert.throws(() => calc.modulo(1, 0), /Division by zero/);

console.log("All tests passed!");
`;

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);
  await seedFile(tmpDir, "calculator.js", SEED_IMPL);
  await seedFile(tmpDir, "calculator.test.js", SEED_TEST);

  try {
    await runWithTimeout(
      agent,
      "The tests in calculator.test.js are failing. Run them, figure out what's wrong with calculator.js, fix the bugs, and re-run the tests until they pass.",
      meta.timeout,
    );

    const content = (await readResult(tmpDir, "calculator.js")) || "";

    // Check that divide no longer truncates (no Math.floor)
    const divideFixed = !content.includes("Math.floor") && content.includes("divide");
    // Check that modulo uses % operator or equivalent correct logic
    const moduloFixed = content.includes("%") ||
      (!content.includes("while") && content.includes("modulo"));

    const didRead = events.anyToolCalled(["read_file"]);
    const didEdit = events.anyToolCalled(["replace_in_file", "write_file"]);
    const ranTests = events.toolCallCount("run_command") >= 1;
    const ranTestsTwice = events.toolCallCount("run_command") >= 2;

    // Check if tests actually pass — look for "All tests passed" in run_command results
    const runResults = events.resultsFor("run_command")
      .map(r => [r?.stdout, r?.stderr, r?.content].filter(Boolean).join("\n")).join("\n");
    const testsPass = runResults.includes("All tests passed");

    return scoreResult(meta.name, [
      check("ran tests", ranTests, 2),
      check("read files", didRead, 1),
      check("edited implementation", didEdit, 2),
      check("divide bug fixed", divideFixed, 3, content.match(/divide[\s\S]{0,120}/)?.[0]),
      check("modulo bug fixed", moduloFixed, 3, content.match(/modulo[\s\S]{0,120}/)?.[0]),
      check("re-ran tests", ranTestsTwice, 2),
      check("tests pass", testsPass, 3, runResults.slice(-200)),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
