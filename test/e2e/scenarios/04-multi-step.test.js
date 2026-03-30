import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, fileExists, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "multi-step", timeout: config.timeouts.complex, category: "multi-step", evalType: "regression", difficulty: "complex" };

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);

  try {
    const response = await runWithTimeout(
      agent,
      'Create a file "math.js" that exports a function add(a, b) returning a+b. Then create "test.js" that requires math.js and console.logs add(2,3). Then run test.js with node and tell me the output.',
      meta.timeout,
    );

    return scoreResult(meta.name, [
      check("math.js exists", fileExists(tmpDir, "math.js"), 2),
      check("test.js exists", fileExists(tmpDir, "test.js"), 2),
      check("used run_command", events.anyToolCalled(["run_command"]), 2),
      check('response contains "5"', response.includes("5"), 3, response.slice(0, 120)),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
