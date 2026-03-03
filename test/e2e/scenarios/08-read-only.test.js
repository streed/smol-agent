import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "read-only", timeout: config.timeouts.simple };

const WRITE_TOOLS = ["write_file", "replace_in_file", "run_command"];

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);
  await seedFile(tmpDir, "secret.txt", "The secret code is ALPHA-7742.\n");

  try {
    const response = await runWithTimeout(
      agent,
      "Read the file secret.txt and tell me what the secret code is. Do NOT modify any files.",
      meta.timeout,
    );

    const noWrites = !events.anyToolCalled(WRITE_TOOLS);
    const writeNames = events.toolNames().filter((n) => WRITE_TOOLS.includes(n));

    return scoreResult(meta.name, [
      check("reports secret code", /ALPHA-7742/i.test(response), 3, response.slice(0, 120)),
      check("no write tool calls", noWrites, 3, writeNames.length > 0 ? writeNames.join(", ") : undefined),
      check("used read_file", events.anyToolCalled(["read_file"]), 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
