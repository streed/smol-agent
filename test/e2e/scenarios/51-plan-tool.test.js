/**
 * Scenario 51 — Plan tools (save, track, complete)
 *
 * Tests that the agent can create a multi-step plan, track progress
 * through steps, and complete them.
 */
import fs from "node:fs";
import path from "node:path";
import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, fileExists, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "plan-tool", timeout: config.timeouts.complex };

export async function run() {
  const { agent, tmpDir } = createTestAgent({ coreToolsOnly: false });
  const events = collectEvents(agent);

  try {
    const response = await runWithTimeout(
      agent,
      'Create a plan to build a simple calculator module, then execute the plan. The plan should have at least 3 steps: 1) Create the calculator.js file with add and subtract functions, 2) Create a test file test-calc.js that tests both functions, 3) Run the tests with node. Use the save_plan tool to create the plan first, then execute each step and mark them complete.',
      meta.timeout,
    );

    // Check if plan tools were used
    const usedSavePlan = events.anyToolCalled(["save_plan"]);
    const usedCompletePlan = events.anyToolCalled(["complete_plan_step"]);

    // Check if plan file was created
    const planFiles = fs.readdirSync(tmpDir).filter(f => f.startsWith("PLAN"));
    const hasPlanFile = planFiles.length > 0;

    // Check if the actual work was done
    const calcExists = fileExists(tmpDir, "calculator.js");
    const testExists = fileExists(tmpDir, "test-calc.js");
    const usedRunCommand = events.anyToolCalled(["run_command"]);

    return scoreResult(meta.name, [
      check("used save_plan tool", usedSavePlan, 2),
      check("plan file created", hasPlanFile, 1),
      check("calculator.js created", calcExists, 2),
      check("test file created", testExists, 2),
      check("ran tests", usedRunCommand, 2),
      check("completed plan steps", usedCompletePlan, 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
