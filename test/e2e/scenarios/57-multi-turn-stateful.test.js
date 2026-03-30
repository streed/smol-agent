/**
 * Scenario 57 — Multi-Turn Stateful Conversation
 *
 * Tests that the agent maintains state across multiple turns, with each
 * turn building on the previous one. Verifies that the agent can reference
 * work from earlier turns and that file modifications accumulate correctly.
 */
import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, fileExists, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "multi-turn-stateful", timeout: config.timeouts.complex, category: "multi-step", evalType: "capability", difficulty: "complex" };

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);

  try {
    // Turn 1: Create a module with initial functions
    await runWithTimeout(
      agent,
      'Create a file "utils.js" with two exported functions: isEmpty(arr) that returns true if array is empty, and first(arr) that returns the first element or undefined.',
      meta.timeout,
    );

    const t1Exists = fileExists(tmpDir, "utils.js");
    const t1Content = (await readResult(tmpDir, "utils.js")) || "";
    const t1HasIsEmpty = /isEmpty/.test(t1Content);
    const t1HasFirst = /first/.test(t1Content);

    // Turn 2: Add more functions, referencing the existing ones
    await runWithTimeout(
      agent,
      'Add a function last(arr) to utils.js that returns the last element. Also add a function compact(arr) that filters out falsy values. Keep all existing functions.',
      meta.timeout,
    );

    const t2Content = (await readResult(tmpDir, "utils.js")) || "";
    const t2HasLast = /last/.test(t2Content);
    const t2HasCompact = /compact/.test(t2Content);
    const t2PreservedIsEmpty = /isEmpty/.test(t2Content);
    const t2PreservedFirst = /first/.test(t2Content);

    // Turn 3: Create a test file that imports from utils.js, referencing all prior work
    const response = await runWithTimeout(
      agent,
      'Create a file "test-utils.js" that requires utils.js and tests all four functions (isEmpty, first, last, compact) by logging results. Run it with node and tell me if they all work.',
      meta.timeout,
    );

    const t3TestExists = fileExists(tmpDir, "test-utils.js");
    const ranTests = events.anyToolCalled(["run_command"]);
    const allFourMentioned = /isEmpty/.test(response) || /first/.test(response) || /last/.test(response) || /compact/.test(response) || /all|four|pass|work/i.test(response);

    // Verify conversation continuity
    const msgCount = agent.getMessages().length;
    const multiTurn = msgCount > 10; // 3 turns × (user + assistant + tool calls)

    return scoreResult(meta.name, [
      check("utils.js created in turn 1", t1Exists && t1HasIsEmpty && t1HasFirst, 2),
      check("turn 2 added last and compact", t2HasLast && t2HasCompact, 2),
      check("turn 2 preserved existing functions", t2PreservedIsEmpty && t2PreservedFirst, 2),
      check("test file created in turn 3", t3TestExists, 1),
      check("ran tests with node", ranTests, 2),
      check("response references test results", allFourMentioned, 1),
      check("conversation continuity across 3 turns", multiTurn, 1, `${msgCount} messages`),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
