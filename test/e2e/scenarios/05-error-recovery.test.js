import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "error-recovery", timeout: config.timeouts.medium, category: "error-handling", evalType: "regression", difficulty: "medium" };

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
    const readAttempts = events.toolCallCount("read_file");
    const noLoop = replaceAttempts <= 5;
    const coherent =
      response.length > 10 &&
      !response.includes("(Agent reached maximum iteration limit)");

    // Verify the agent recognized the file doesn't exist (not just any "error" keyword)
    const mentionsFileMissing =
      /not found|doesn't exist|does not exist|no such file|missing|cannot find|couldn't find|file.*not/i.test(response);

    // Check tool results for actual file-not-found errors
    const toolResults = [...events.resultsFor("read_file"), ...events.resultsFor("replace_in_file")];
    const toolHitError = toolResults.some(r =>
      /not found|no such|ENOENT|does not exist/i.test(JSON.stringify(r || ""))
    );

    return scoreResult(meta.name, [
      check("no infinite loop (≤5 attempts)", noLoop, 3, `${replaceAttempts} replace, ${readAttempts} read attempts`),
      check("coherent response", coherent, 2, response.slice(0, 120)),
      check("mentions file missing", mentionsFileMissing, 2, response.slice(0, 120)),
      check("tool encountered file error", toolHitError, 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
