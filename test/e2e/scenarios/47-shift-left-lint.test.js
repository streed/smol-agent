/**
 * Scenario 47 — Shift-left lint feedback
 *
 * Tests that the agent can create files in a project that has a lint
 * script defined, and produce syntactically valid output. The shift-left
 * system should auto-run the linter after modifications.
 */
import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, fileExists, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "shift-left-lint", timeout: config.timeouts.medium };

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);

  // Seed a package.json with a lint script that checks syntax
  await seedFile(tmpDir, "package.json", JSON.stringify({
    name: "lint-test",
    version: "1.0.0",
    scripts: {
      lint: "node --check src/*.js",
    },
  }, null, 2));

  // Create src directory
  await seedFile(tmpDir, "src/.gitkeep", "");

  try {
    const response = await runWithTimeout(
      agent,
      'Create a file src/calculator.js that exports functions add(a,b), subtract(a,b), and multiply(a,b). Each should return the correct result. Make sure the code is syntactically valid JavaScript.',
      meta.timeout,
    );

    const exists = fileExists(tmpDir, "src/calculator.js");
    const content = (await readResult(tmpDir, "src/calculator.js")) || "";

    // Check that the code is valid JS by trying to parse it
    let validSyntax = false;
    try {
      new Function(content);
      validSyntax = true;
    } catch {
      // Also try as module syntax (export statements)
      try {
        // If it uses export, that's fine — just check for obvious syntax errors
        validSyntax = !(/\bfunction\s*\(/.test(content) && content.includes("}{"));
        // More robust: check that it has balanced braces
        const opens = (content.match(/\{/g) || []).length;
        const closes = (content.match(/\}/g) || []).length;
        validSyntax = opens === closes;
      } catch { /* keep false */ }
    }

    const hasAdd = /function\s+add|const\s+add|export\s+(function|const)\s+add/.test(content);
    const hasSubtract = /function\s+subtract|const\s+subtract|export\s+(function|const)\s+subtract/.test(content);
    const hasMultiply = /function\s+multiply|const\s+multiply|export\s+(function|const)\s+multiply/.test(content);

    return scoreResult(meta.name, [
      check("file exists", exists, 2),
      check("valid syntax", validSyntax, 3),
      check("has add function", hasAdd, 1),
      check("has subtract function", hasSubtract, 1),
      check("has multiply function", hasMultiply, 1),
      check("used write tool", events.anyToolCalled(["write_file"]), 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
