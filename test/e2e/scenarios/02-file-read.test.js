import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "file-read", timeout: config.timeouts.simple, category: "file-ops", evalType: "regression", difficulty: "simple" };

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);
  await seedFile(tmpDir, "data.txt", "The answer is 42.\n");

  try {
    const response = await runWithTimeout(
      agent,
      "Read the file data.txt and tell me what number is in it.",
      meta.timeout,
    );

    // Verify the agent read the correct file
    const readCalls = events.tool_calls.filter(tc => tc.name === "read_file");
    const readDataTxt = readCalls.some(tc => {
      const args = tc.args || tc.arguments || {};
      return /data\.txt/i.test(args.filePath || "");
    });

    return scoreResult(meta.name, [
      check("response contains 42", response.includes("42"), 3, response.slice(0, 120)),
      check("used read_file tool", events.anyToolCalled(["read_file"]), 1),
      check("read the correct file (data.txt)", readDataTxt, 2, readCalls.map(tc => (tc.args || tc.arguments || {}).filePath).join(", ")),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
