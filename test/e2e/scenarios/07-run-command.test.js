import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "run-command", timeout: config.timeouts.simple };

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);

  try {
    const response = await runWithTimeout(
      agent,
      'Run the command: node -e "console.log(1+1)" and tell me the output.',
      meta.timeout,
    );

    return scoreResult(meta.name, [
      check("used run_command", events.anyToolCalled(["run_command"]), 3),
      check('response contains "2"', response.includes("2"), 3, response.slice(0, 120)),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
