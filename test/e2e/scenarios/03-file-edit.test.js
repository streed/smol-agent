import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "file-edit", timeout: config.timeouts.medium, category: "file-ops", evalType: "regression", difficulty: "medium" };

const SEED_CONFIG = JSON.stringify(
  { host: "localhost", port: 3000, debug: true },
  null,
  2,
);

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);
  await seedFile(tmpDir, "config.json", SEED_CONFIG);

  try {
    await runWithTimeout(
      agent,
      "Edit config.json to change the port from 3000 to 8080.",
      meta.timeout,
    );

    const raw = (await readResult(tmpDir, "config.json")) || "";
    let parsed = null;
    let validJson = false;
    try { parsed = JSON.parse(raw); validJson = true; } catch { /* invalid */ }

    return scoreResult(meta.name, [
      check("port changed to 8080", parsed?.port === 8080, 3, parsed?.port),
      check("valid JSON", validJson, 2, raw.slice(0, 80)),
      check("host preserved", parsed?.host === "localhost", 2, parsed?.host),
      check("debug preserved", parsed?.debug === true, 1, parsed?.debug),
      check("used edit tool", events.anyToolCalled(["replace_in_file", "write_file"]), 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
