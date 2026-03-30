import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "run-command", timeout: config.timeouts.simple, category: "agent-behavior", evalType: "regression", difficulty: "simple" };

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);

  try {
    const response = await runWithTimeout(
      agent,
      'Run the command: node -e "console.log(1+1)" and tell me the output.',
      meta.timeout,
    );

    // Check the command output was "2" (not just that "2" appears somewhere)
    const cmdResults = events.resultsFor("run_command");
    const outputHas2 = cmdResults.some(r =>
      /\b2\b/.test(r?.stdout || r?.output || "")
    );

    return scoreResult(meta.name, [
      check("used run_command", events.anyToolCalled(["run_command"]), 3),
      check('response contains "2"', response.includes("2"), 2, response.slice(0, 120)),
      check("command output contains 2", outputHas2, 2, cmdResults.map(r => (r?.stdout || r?.output || "").slice(0, 80)).join("; ")),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
