import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, fileExists, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "multi-turn", timeout: config.timeouts.complex };

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);

  try {
    // Turn 1: create a file
    const r1 = await runWithTimeout(
      agent,
      'Create a file "counter.js" that exports a variable count set to 0 and a function increment() that adds 1 to count and returns it.',
      meta.timeout,
    );

    const fileCreated = fileExists(tmpDir, "counter.js");
    const content1 = (await readResult(tmpDir, "counter.js")) || "";
    const hasIncrement = /increment/.test(content1);

    // Turn 2: modify the same file, referencing turn 1's context
    const r2 = await runWithTimeout(
      agent,
      'Now add a decrement() function to counter.js that subtracts 1 from count and returns it. Keep the existing code.',
      meta.timeout,
    );

    const content2 = (await readResult(tmpDir, "counter.js")) || "";
    const hasDecrement = /decrement/.test(content2);
    const stillHasIncrement = /increment/.test(content2);
    const hasBoth = hasDecrement && stillHasIncrement;

    // Verify the agent used the same conversation (messages grew)
    const msgCount = agent.getMessages().length;
    const multiTurn = msgCount > 6; // system + 2x(user + assistant + tools)

    return scoreResult(meta.name, [
      check("file created in turn 1", fileCreated, 2),
      check("has increment after turn 1", hasIncrement, 2, content1.slice(0, 120)),
      check("has decrement after turn 2", hasDecrement, 3, content2.slice(0, 120)),
      check("increment preserved in turn 2", stillHasIncrement, 2),
      check("conversation continuity", multiTurn, 2, `${msgCount} messages`),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
