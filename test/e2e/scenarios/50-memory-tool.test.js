/**
 * Scenario 50 — Memory / remember tool
 *
 * Tests that the agent can use the remember tool to persist facts
 * and that saved memories are accessible.
 */
import fs from "node:fs";
import path from "node:path";
import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "memory-tool", timeout: config.timeouts.medium, category: "agent-behavior", evalType: "capability", difficulty: "medium" };

export async function run() {
  const { agent, tmpDir } = createTestAgent({ coreToolsOnly: false });
  const events = collectEvents(agent);

  try {
    const response = await runWithTimeout(
      agent,
      'Remember the following facts using the remember tool: 1) The project uses PostgreSQL as its database. 2) The deployment target is AWS Lambda. Then confirm what you remembered.',
      meta.timeout,
    );

    // Check if the remember tool was called
    const usedRemember = events.anyToolCalled(["remember"]);

    // Check if memory file was created
    const memoryPath = path.join(tmpDir, ".smol-agent", "memory.json");
    const memoryExists = fs.existsSync(memoryPath);

    let memoryContent = "";
    let hasPostgres = false;
    let hasLambda = false;
    if (memoryExists) {
      memoryContent = fs.readFileSync(memoryPath, "utf-8");
      hasPostgres = /postgres/i.test(memoryContent);
      hasLambda = /lambda|aws/i.test(memoryContent);
    }

    // Also check the response
    const responseConfirms = /postgres/i.test(response) || /lambda/i.test(response) || /remember/i.test(response);

    return scoreResult(meta.name, [
      check("used remember tool", usedRemember, 3),
      check("memory file created", memoryExists, 2, memoryPath),
      check("stored PostgreSQL fact", hasPostgres, 2),
      check("stored Lambda fact", hasLambda, 2),
      check("response confirms", responseConfirms, 1, response.slice(0, 200)),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
