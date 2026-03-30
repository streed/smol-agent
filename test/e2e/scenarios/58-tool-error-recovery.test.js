/**
 * Scenario 58 — Tool Error Recovery and Graceful Handling
 *
 * Tests that the agent handles tool errors gracefully:
 * - Reading a nonexistent file produces an error, agent adapts
 * - Running a command that fails, agent interprets the error
 * - Agent doesn't get stuck in a loop and completes the overall task
 */
import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, fileExists, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "tool-error-recovery", timeout: config.timeouts.medium, category: "error-handling", evalType: "regression", difficulty: "medium" };

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);

  // Seed only one file — the agent will be asked about files that don't exist
  await seedFile(tmpDir, "src/app.js", 'export function main() { return "hello"; }\n');

  try {
    const response = await runWithTimeout(
      agent,
      'Read the file "src/config.js" and tell me what it contains. If it does not exist, create it with a default export containing { port: 3000, env: "development" }. Then read "src/app.js" and tell me what both files contain.',
      meta.timeout,
    );

    // The agent should have tried to read config.js (which doesn't exist)
    const readCalls = events.tool_calls.filter(tc => tc.name === "read_file");
    const triedReadConfig = readCalls.some(tc => {
      const args = tc.args || tc.arguments || {};
      return /config/i.test(args.filePath || "");
    });

    // After the error, it should have created config.js
    const configExists = fileExists(tmpDir, "src/config.js");
    const configContent = (await readResult(tmpDir, "src/config.js")) || "";
    const hasPort = /3000/.test(configContent);
    const hasEnv = /development/.test(configContent);

    // Should have also read app.js successfully
    const triedReadApp = readCalls.some(tc => {
      const args = tc.args || tc.arguments || {};
      return /app/i.test(args.filePath || "");
    });

    // Response should mention both files
    const mentionsConfig = /config|port|3000|development/i.test(response);
    const mentionsApp = /app|main|hello/i.test(response);

    // Agent should have encountered at least one error and recovered
    const readResults = events.tool_results.filter(tr => tr.name === "read_file");
    const hadReadError = readResults.some(tr => {
      const result = tr.result || {};
      return result.error || /not found|no such|ENOENT/i.test(JSON.stringify(result));
    });

    return scoreResult(meta.name, [
      check("tried reading nonexistent config.js", triedReadConfig, 1),
      check("recovered and created config.js", configExists, 3),
      check("config.js has port 3000", hasPort, 1),
      check("config.js has development env", hasEnv, 1),
      check("also read app.js", triedReadApp, 1),
      check("response covers both files", mentionsConfig && mentionsApp, 2),
      check("gracefully handled read error", hadReadError, 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
