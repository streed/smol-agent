import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, fileExists, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "file-create", timeout: config.timeouts.simple };

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);

  try {
    await runWithTimeout(
      agent,
      'Create a file called "hello.js" that exports a function named hello which returns the string "Hello, world!".',
      meta.timeout,
    );

    const exists = fileExists(tmpDir, "hello.js");
    const content = (await readResult(tmpDir, "hello.js")) || "";
    const hasFunction = /function\s+hello|const\s+hello|let\s+hello|var\s+hello/.test(content);
    const hasString = content.includes("Hello, world!");
    const hasExport = /module\.exports|export\s/.test(content);
    const usedWrite = events.anyToolCalled(["write_file"]);

    return scoreResult(meta.name, [
      check("file exists", exists, 3),
      check("has function", hasFunction, 2, content.slice(0, 120)),
      check("has correct string", hasString, 2),
      check("has export", hasExport, 1),
      check("used write_file tool", usedWrite, 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
