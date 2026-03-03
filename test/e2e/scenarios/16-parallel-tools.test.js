import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "parallel-tools", timeout: config.timeouts.medium };

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);

  // Seed 5 independent files — a task that naturally invites parallel reads
  await seedFile(tmpDir, "alpha.txt", "Color: red\nCount: 10\n");
  await seedFile(tmpDir, "beta.txt", "Color: blue\nCount: 20\n");
  await seedFile(tmpDir, "gamma.txt", "Color: green\nCount: 30\n");
  await seedFile(tmpDir, "delta.txt", "Color: yellow\nCount: 40\n");
  await seedFile(tmpDir, "epsilon.txt", "Color: purple\nCount: 50\n");

  try {
    const response = await runWithTimeout(
      agent,
      "Read all five .txt files (alpha, beta, gamma, delta, epsilon) and tell me the total count across all files.",
      meta.timeout,
    );

    const readCount = events.toolCallCount("read_file");
    const mentionsTotal = response.includes("150");
    const readAllFiles = readCount >= 5;

    // Check timeline to see if multiple reads happened close together (parallel)
    const readEvents = events.timeline.filter((e) => e.event === "tool_call" && e.data.name === "read_file");
    let hasParallelBatch = false;
    if (readEvents.length >= 2) {
      // Check if any two reads started within 50ms of each other
      for (let i = 1; i < readEvents.length; i++) {
        if (readEvents[i].ts - readEvents[i - 1].ts < 50) {
          hasParallelBatch = true;
          break;
        }
      }
    }

    return scoreResult(meta.name, [
      check("read all 5 files", readAllFiles, 2, `${readCount} reads`),
      check("correct total (150)", mentionsTotal, 3, response.slice(0, 160)),
      check("used parallel execution", hasParallelBatch, 2, readEvents.map((e) => e.ts).join(", ")),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
