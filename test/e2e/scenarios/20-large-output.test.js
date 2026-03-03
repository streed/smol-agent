import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "large-output", timeout: config.timeouts.medium };

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);

  try {
    const response = await runWithTimeout(
      agent,
      'Run this command: node -e "for(let i=0;i<500;i++) console.log(\'line \'+i+\': \'+\'x\'.repeat(80))" — then tell me how many lines of output there were.',
      meta.timeout,
    );

    const ranCmd = events.anyToolCalled(["run_command"]);
    const cmdResults = events.resultsFor("run_command");

    // The agent should have run it and gotten output (possibly truncated)
    const gotOutput = cmdResults.length > 0 && cmdResults.some((r) =>
      r?.stdout?.includes("line") || r?.output?.includes("line"),
    );

    // Agent should mention the count or that there was a lot of output
    const mentionsCount = /500|lines?|output/i.test(response);
    const noError = !cmdResults.some((r) => r?.error);

    return scoreResult(meta.name, [
      check("ran the command", ranCmd, 3),
      check("got output", gotOutput, 2, cmdResults[0] ? JSON.stringify(cmdResults[0]).slice(0, 120) : "no result"),
      check("mentions output count/size", mentionsCount, 2, response.slice(0, 160)),
      check("no command error", noError, 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
