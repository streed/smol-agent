/**
 * Scenario 56 — Context Management Under Pressure
 *
 * Tests that the agent can handle a conversation that generates a lot of
 * context (reading multiple large files, running commands with large output)
 * without crashing or losing coherence. Verifies that context management
 * (pruning, truncation) keeps things working.
 */
import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "context-pressure", timeout: config.timeouts.complex };

export async function run() {
  const { agent, tmpDir } = createTestAgent({ contextSize: 16384 });
  const events = collectEvents(agent);

  // Seed several files with substantial content to fill context
  const largeContent = Array.from({ length: 100 }, (_, i) =>
    `function handler_${i}(req, res) {\n  const data = req.body;\n  if (!data) return res.status(400).json({ error: "missing body" });\n  res.json({ id: ${i}, result: process.env.SECRET_${i} || "default" });\n}\n`
  ).join("\n");

  await seedFile(tmpDir, "src/handlers.js", largeContent);
  await seedFile(tmpDir, "src/config.js", Array.from({ length: 50 }, (_, i) =>
    `export const CONFIG_${i} = { timeout: ${1000 + i * 100}, retries: ${i % 5}, endpoint: "https://api.example.com/v${i}" };`
  ).join("\n"));
  await seedFile(tmpDir, "src/models.js", Array.from({ length: 50 }, (_, i) =>
    `class Model${i} {\n  constructor(data) { this.id = ${i}; this.data = data; }\n  validate() { return this.data != null; }\n  toJSON() { return { id: this.id, data: this.data }; }\n}`
  ).join("\n"));

  try {
    const response = await runWithTimeout(
      agent,
      'Read all three files in src/ (handlers.js, config.js, models.js), then write me a summary of: 1) How many handler functions exist, 2) What config values are defined, 3) What models are available. Be specific with counts.',
      meta.timeout,
    );

    // Check that all files were read
    const readCount = events.toolCallCount("read_file");
    const readAllFiles = readCount >= 3;

    // Check response quality — agent should have meaningful output despite context pressure
    const mentionsHandlers = /handler|100|functions?/i.test(response);
    const mentionsConfig = /config|50|CONFIG/i.test(response);
    const mentionsModels = /model|50|Model/i.test(response);
    const coherentResponse = response.length > 50 && !/error|crash|fail/i.test(response);

    // No crash or context overflow errors
    const noContextErrors = !events.errors.some(e =>
      /context|overflow|token/i.test(e.message || "")
    );

    return scoreResult(meta.name, [
      check("read all 3 files", readAllFiles, 2, `${readCount} reads`),
      check("mentions handlers", mentionsHandlers, 2, response.slice(0, 200)),
      check("mentions config", mentionsConfig, 2),
      check("mentions models", mentionsModels, 2),
      check("coherent response", coherentResponse, 1),
      check("no context overflow errors", noContextErrors, 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
