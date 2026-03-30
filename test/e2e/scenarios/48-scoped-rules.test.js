/**
 * Scenario 48 — Subdirectory-scoped AGENT.md rules
 *
 * Tests that the agent picks up and follows AGENT.md rules placed in
 * a subdirectory, applying conventions specific to that module.
 */
import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, fileExists, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "scoped-rules", timeout: config.timeouts.medium, category: "context", evalType: "regression", difficulty: "medium" };

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);

  // Seed subdirectory rules requiring snake_case function names
  await seedFile(tmpDir, "lib/AGENT.md", `# Conventions for lib/
- All function names MUST use snake_case (e.g. get_user, parse_input)
- All files MUST have a comment header with the filename
- Use CommonJS module.exports (not ES modules)
`);

  // Seed an existing file to give context
  await seedFile(tmpDir, "lib/utils.js", `// utils.js
function get_timestamp() {
  return Date.now();
}

module.exports = { get_timestamp };
`);

  try {
    await runWithTimeout(
      agent,
      'Create a new file lib/validators.js with two functions: one to check if a string is a valid email (contains @ and .), and one to check if a number is positive.',
      meta.timeout,
    );

    const exists = fileExists(tmpDir, "lib/validators.js");
    const content = (await readResult(tmpDir, "lib/validators.js")) || "";

    // Check that conventions were followed
    const hasSnakeCase = /function\s+[a-z]+_[a-z]+/.test(content) ||
                         /[a-z]+_[a-z]+\s*[=:]/.test(content);
    const hasCamelCase = /function\s+[a-z]+[A-Z]/.test(content);
    const hasCommonJS = /module\.exports/.test(content);
    const hasESM = /\bexport\s/.test(content);
    const hasHeaderComment = /^\/\/\s*validator/im.test(content);
    const hasEmailFn = /email|mail/i.test(content);
    const hasPositiveFn = /positive|is_positive|isPositive/i.test(content);

    // Verify the agent discovered the AGENT.md rules
    const readCalls = events.tool_calls.filter(tc => tc.name === "read_file");
    const readAgentMd = readCalls.some(tc => {
      const args = tc.args || tc.arguments || {};
      return /AGENT\.md/i.test(args.filePath || "");
    });

    return scoreResult(meta.name, [
      check("file exists", exists, 2),
      check("uses snake_case", hasSnakeCase && !hasCamelCase, 3, content.slice(0, 200)),
      check("uses CommonJS exports", hasCommonJS && !hasESM, 2),
      check("has comment header", hasHeaderComment, 1),
      check("has email validator", hasEmailFn, 1),
      check("has positive checker", hasPositiveFn, 1),
      check("discovered AGENT.md rules", readAgentMd, 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
