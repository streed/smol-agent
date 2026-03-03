import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "circuit-breaker", timeout: config.timeouts.medium };

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);

  // Seed a file with content that doesn't match what the prompt implies.
  // The agent will repeatedly try replace_in_file with wrong oldText.
  await seedFile(tmpDir, "data.txt", "The value is alpha.\nStatus: active.\n");

  try {
    const response = await runWithTimeout(
      agent,
      'In data.txt, replace the line "result: pending" with "result: done". This exact text must be in the file — find it and replace it.',
      meta.timeout,
    );

    const replaceAttempts = events.toolCallCount("replace_in_file");
    // Circuit breaker should cap at ~3 consecutive failures for the same tool
    const capped = replaceAttempts <= 6;
    const noIterationLimit = !response.includes("(Agent reached maximum iteration limit)");
    const resolved = response.length > 10;

    // Check that replace_in_file results contain errors (the text doesn't exist)
    const replaceResults = events.resultsFor("replace_in_file");
    const hadErrors = replaceResults.some((r) => r?.error);

    return scoreResult(meta.name, [
      check("replace attempts capped", capped, 3, `${replaceAttempts} attempts`),
      check("didn't hit iteration limit", noIterationLimit, 2),
      check("agent resolved gracefully", resolved, 2, response.slice(0, 160)),
      check("encountered replace errors", hadErrors, 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
