import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "self-correction", timeout: config.timeouts.complex, category: "error-handling", evalType: "capability", difficulty: "complex" };

const SEED_APP = `function greet(name) {
  return "Hello, " + name;
}

function farewell(name) {
  return "Goodbye, " + name;
}

module.exports = { greet, farewell };
`;

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);
  await seedFile(tmpDir, "app.js", SEED_APP);

  try {
    await runWithTimeout(
      agent,
      'Edit app.js to change the greet function so it takes two parameters (name, greeting) and returns greeting + ", " + name instead of "Hello, " + name. Keep the farewell function unchanged.',
      meta.timeout,
    );

    const content = (await readResult(tmpDir, "app.js")) || "";

    const hasNewSig =
      /function\s+greet\s*\(\s*name\s*,\s*greeting\s*\)|greet\s*=\s*\(\s*name\s*,\s*greeting\s*\)/.test(content);

    // Verify greeting parameter is used in the return value (concatenation or template literal)
    const usesGreetingInReturn =
      /greeting\s*\+\s*["',]/.test(content) ||
      /["']\s*\+\s*greeting/.test(content) ||
      /`\$\{greeting\}/.test(content) ||
      /greeting\s*\+\s*['"]/.test(content);

    // Old "Hello, " should be removed from greet function
    const oldHelloRemoved = !/return\s*["']Hello/.test(content);

    const farewellOk = /function\s+farewell/.test(content) && content.includes("Goodbye");

    return scoreResult(meta.name, [
      check("new signature (name, greeting)", hasNewSig, 3, content.slice(0, 160)),
      check("greeting used in return value", usesGreetingInReturn, 2),
      check("old 'Hello' hardcode removed", oldHelloRemoved, 1),
      check("farewell function preserved", farewellOk, 2),
      check("used edit tool", events.anyToolCalled(["replace_in_file", "write_file"]), 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
