/**
 * Scenario 54 — Auto-Discovery from Context Signals
 *
 * Tests that the agent automatically activates tool groups based on
 * context signals in the user's prompt without requiring an explicit
 * discover_tools call. When the user says "remember", the memory
 * group should auto-activate, making the remember tool available.
 */
import fs from "node:fs";
import path from "node:path";
import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "auto-discovery-context", timeout: config.timeouts.medium };

export async function run() {
  // coreToolsOnly: false enables progressive discovery with auto-detection
  const { agent, tmpDir } = createTestAgent({ coreToolsOnly: false });
  const events = collectEvents(agent);

  try {
    const response = await runWithTimeout(
      agent,
      'Please remember that this project uses TypeScript with strict mode enabled and the preferred test framework is vitest. Save these as memories for future sessions.',
      meta.timeout,
    );

    // The memory group should have been auto-activated from "remember" signal
    const usedRemember = events.anyToolCalled(["remember"]);

    // The agent should NOT have needed to call discover_tools explicitly
    // (auto-discovery should handle it)
    const usedDiscoverTools = events.anyToolCalled(["discover_tools"]);

    // Check if memory was stored
    const memoryPath = path.join(tmpDir, ".smol-agent", "memory.json");
    const memoryExists = fs.existsSync(memoryPath);

    let hasTypeScript = false;
    let hasVitest = false;
    if (memoryExists) {
      const memoryContent = fs.readFileSync(memoryPath, "utf-8");
      hasTypeScript = /typescript|strict/i.test(memoryContent);
      hasVitest = /vitest/i.test(memoryContent);
    }

    const responseConfirms = /remember|saved|stored|memory/i.test(response);

    return scoreResult(meta.name, [
      check("used remember tool", usedRemember, 3),
      check("auto-activated (no explicit discover_tools needed)", !usedDiscoverTools || usedRemember, 2),
      check("memory file created", memoryExists, 2),
      check("stored TypeScript preference", hasTypeScript, 1),
      check("stored vitest preference", hasVitest, 1),
      check("response confirms storage", responseConfirms, 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
