/**
 * Scenario 53 — Progressive Tool Discovery
 *
 * Tests that the agent starts with only starter tool groups (explore, edit, execute)
 * and can unlock additional groups via the discover_tools meta-tool.
 * Verifies that requesting plan tools makes them available and usable.
 */
import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "progressive-discovery", timeout: config.timeouts.complex, category: "agent-behavior", evalType: "capability", difficulty: "complex" };

export async function run() {
  // coreToolsOnly: false enables progressive discovery
  const { agent, tmpDir } = createTestAgent({ coreToolsOnly: false });
  const events = collectEvents(agent);

  try {
    const response = await runWithTimeout(
      agent,
      'I need to create a plan for building a todo app. First, use discover_tools to activate the "plan" group, then use save_plan to create a plan with at least 3 steps for building a todo app with add, remove, and list features.',
      meta.timeout,
    );

    // Check that discover_tools was called to activate the plan group
    const usedDiscoverTools = events.anyToolCalled(["discover_tools"]);

    // Check that plan tools became available and were used
    const usedSavePlan = events.anyToolCalled(["save_plan"]);

    // Check the discover_tools call had the right arguments
    const discoverCalls = events.tool_calls.filter(tc => tc.name === "discover_tools");
    const activatedPlan = discoverCalls.some(tc => {
      const args = tc.args || tc.arguments || {};
      const groups = args.groups || [];
      return groups.includes("plan");
    });

    // Check response quality
    const mentionsTodo = /todo/i.test(response);
    const hasSteps = /add|remove|list|create|delete/i.test(response);

    return scoreResult(meta.name, [
      check("used discover_tools", usedDiscoverTools, 3),
      check("activated plan group", activatedPlan || usedSavePlan, 2),
      check("used save_plan after activation", usedSavePlan, 3),
      check("response mentions todo app", mentionsTodo, 1),
      check("response includes feature steps", hasSteps, 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
