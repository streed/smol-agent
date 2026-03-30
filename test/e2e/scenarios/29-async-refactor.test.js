import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "async-refactor", timeout: config.timeouts.complex, category: "code-transform", evalType: "capability", difficulty: "complex" };

const SEED_CODE = `const fs = require("fs");

function readConfig(path) {
  const data = fs.readFileSync(path, "utf8");
  return JSON.parse(data);
}

function writeConfig(path, config) {
  const data = JSON.stringify(config, null, 2);
  fs.writeFileSync(path, data);
}

module.exports = { readConfig, writeConfig };
`;

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);
  await seedFile(tmpDir, "config-io.js", SEED_CODE);

  try {
    await runWithTimeout(
      agent,
      "Refactor these functions to use async/await with fs.promises instead of sync operations",
      meta.timeout,
    );

    const content = (await readResult(tmpDir, "config-io.js")) || "";

    const didRead = events.anyToolCalled(["read_file"]);
    const didEdit = events.anyToolCalled(["replace_in_file", "write_file"]);

    // Check for async/await
    const hasAsyncKeyword = /async\s+function/.test(content);
    const hasAwait = /await/.test(content);

    // Check for fs.promises
    const usesFsPromises = /fs\.promises|require\(['"]fs\/promises['"]/.test(content) ||
                          /import.*fs\/promises/.test(content);

    // Check specific functions were converted
    const readIsAsync = /async\s+function\s+readConfig/.test(content);
    const writeIsAsync = /async\s+function\s+writeConfig/.test(content);

    // Verify sync operations were actually removed
    const noSyncOps = !content.includes("readFileSync") && !content.includes("writeFileSync");

    // Functions still exported
    const stillExported = /module\.exports.*readConfig.*writeConfig|exports\.\w+/.test(content);

    return scoreResult(meta.name, [
      check("read source file", didRead, 1),
      check("made edits", didEdit, 1),
      check("added async keyword", hasAsyncKeyword, 2, content.slice(0, 150)),
      check("uses await", hasAwait, 2),
      check("uses fs.promises", usesFsPromises, 2),
      check("readConfig is async", readIsAsync, 1),
      check("writeConfig is async", writeIsAsync, 1),
      check("sync operations removed", noSyncOps, 1),
      check("functions still exported", stillExported, 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
