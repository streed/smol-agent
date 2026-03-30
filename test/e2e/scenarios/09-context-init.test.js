import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "context-init", timeout: config.timeouts.simple, category: "context", evalType: "regression", difficulty: "simple" };

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);
  await seedFile(
    tmpDir,
    "package.json",
    JSON.stringify({ name: "test-project", version: "1.0.0", main: "index.js" }, null, 2),
  );
  await seedFile(tmpDir, "index.js", 'console.log("hello");\n');

  try {
    const response = await runWithTimeout(
      agent,
      "What kind of project is this? Look at the files and tell me.",
      meta.timeout,
    );

    // Verify the agent actually explored the project files
    const didExplore = events.anyToolCalled(["read_file", "list_files"]);

    return scoreResult(meta.name, [
      check("identifies Node.js/JavaScript", /node|javascript|js|npm/i.test(response), 3, response.slice(0, 160)),
      check("mentions package.json", /package\.json/i.test(response), 1),
      check("explored project files", didExplore, 2),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
