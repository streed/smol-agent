import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "whitespace-replace", timeout: config.timeouts.medium };

// Seed with inconsistent whitespace (tabs + trailing spaces) to exercise
// the 3-level matching strategy in replace_in_file.
const SEED = [
  "function greet() {",
  "\t  return   'hello';", // mixed tabs + double space
  "}",
  "",
  "function farewell() {",
  "\treturn 'bye';",
  "}",
].join("\n");

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);
  await seedFile(tmpDir, "greet.js", SEED);

  try {
    await runWithTimeout(
      agent,
      'In greet.js, change the greet function to return "hi there" instead of "hello". Don\'t change farewell.',
      meta.timeout,
    );

    const content = (await readResult(tmpDir, "greet.js")) || "";
    const hasNewString = /hi there/i.test(content);
    const farewellOk = content.includes("bye");
    const stillValid = content.includes("function greet");
    const usedReplace = events.anyToolCalled(["replace_in_file", "write_file"]);

    return scoreResult(meta.name, [
      check("return value changed", hasNewString, 3, content.slice(0, 160)),
      check("farewell preserved", farewellOk, 2),
      check("greet function intact", stillValid, 2),
      check("used edit tool", usedReplace, 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
