import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "self-correction", timeout: config.timeouts.complex };

const SEED_APP = `function greet(name) {
  return "Hello, " + name;
}

function farewell(name) {
  return "Goodbye, " + name;
}

module.exports = { greet, farewell };
`;

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);
  await seedFile(tmpDir, "app.js", SEED_APP);

  try {
    await runWithTimeout(
      agent,
      'Edit app.js to change the greet function so it takes two parameters (name, greeting) and returns greeting + ", " + name instead of "Hello, " + name. Keep the farewell function unchanged.',
      meta.timeout,
    );

    const content = (await readResult(tmpDir, "app.js")) || "";

    const hasNewSig =
      /function\s+greet\s*\(\s*name\s*,\s*greeting\s*\)|greet\s*=\s*\(\s*name\s*,\s*greeting\s*\)/.test(content);
    const usesParam =
      content.includes("greeting") &&
      (/greeting\s*\+/.test(content) || /`\$\{greeting\}/.test(content) || content.includes("greeting +"));
    const farewellOk = content.includes("farewell") && content.includes("Goodbye");

    return scoreResult(meta.name, [
      check("new signature (name, greeting)", hasNewSig, 3, content.slice(0, 160)),
      check("uses greeting parameter", usesParam, 2),
      check("farewell preserved", farewellOk, 2),
      check("used edit tool", events.anyToolCalled(["replace_in_file", "write_file"]), 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
