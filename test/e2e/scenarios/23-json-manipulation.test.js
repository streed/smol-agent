import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "json-manipulation", timeout: config.timeouts.medium, category: "code-transform", evalType: "regression", difficulty: "medium" };

const SEED_PACKAGE = {
  "name": "test-app",
  "version": "1.0.0",
  "scripts": {
    "start": "node index.js"
  },
  "dependencies": {}
};

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);
  await seedFile(tmpDir, "package.json", JSON.stringify(SEED_PACKAGE, null, 2));

  try {
    await runWithTimeout(
      agent,
      "Add lodash@4.17.21 as a dependency and add a 'test' script that runs 'jest'",
      meta.timeout,
    );

    const content = (await readResult(tmpDir, "package.json")) || "";
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = null;
    }

    const didRead = events.anyToolCalled(["read_file"]);
    const didWrite = events.anyToolCalled(["write_file", "replace_in_file"]);
    const isValidJSON = parsed !== null;
    // Accept lodash version with or without version prefix (^, ~, etc.)
    const lodashVersion = parsed?.dependencies?.lodash || "";
    const hasLodash = lodashVersion === "4.17.21" || lodashVersion === "^4.17.21" || lodashVersion === "~4.17.21";
    const hasTestScript = parsed?.scripts?.test === "jest";
    const preservedName = parsed?.name === "test-app";
    const preservedStart = parsed?.scripts?.start === "node index.js";

    return scoreResult(meta.name, [
      check("read package.json", didRead, 1),
      check("wrote changes", didWrite, 1),
      check("valid JSON", isValidJSON, 2, content.slice(0, 100)),
      check("added lodash dependency", hasLodash, 3, `got: ${lodashVersion}`),
      check("added test script", hasTestScript, 2, parsed?.scripts),
      check("preserved name field", preservedName, 1),
      check("preserved start script", preservedStart, 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
