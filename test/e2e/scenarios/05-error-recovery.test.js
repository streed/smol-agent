import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "error-recovery", timeout: config.timeouts.medium };

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);

  try {
    const response = await runWithTimeout(
      agent,
      'Replace the word "foo" with "bar" in the file important.txt.',
      meta.timeout,
    );

    const replaceAttempts = events.toolCallCount("replace_in_file");
    const noLoop = replaceAttempts <= 5;
    const coherent =
      response.length > 10 &&
      !response.includes("(Agent reached maximum iteration limit)");
    const mentionsError =
      /not found|doesn't exist|does not exist|no such|missing|error|cannot|couldn't/i.test(response);

    return scoreResult(meta.name, [
      check("no infinite loop", noLoop, 3, `${replaceAttempts} attempts`),
      check("coherent response", coherent, 2, response.slice(0, 120)),
      check("mentions error/missing file", mentionsError, 2, response.slice(0, 120)),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
