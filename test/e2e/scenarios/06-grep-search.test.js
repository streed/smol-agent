import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "grep-search", timeout: config.timeouts.simple };

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);
  await seedFile(tmpDir, "src/app.js", 'const APP_NAME = "MyApp";\nconsole.log(APP_NAME);\n');
  await seedFile(tmpDir, "src/config.js", 'const APP_VERSION = "1.0";\nexport default { APP_VERSION };\n');
  await seedFile(tmpDir, "src/utils.js", 'function helper() { return "no match here"; }\n');

  try {
    const response = await runWithTimeout(
      agent,
      'Search the src/ directory for files that contain "APP". Tell me which files contain it.',
      meta.timeout,
    );

    const mentionsApp = /app\.js/i.test(response);
    const mentionsConfig = /config\.js/i.test(response);
    const correctlyExcludes =
      !/utils\.js/i.test(response) || /no match|not found|does not contain/i.test(response);

    return scoreResult(meta.name, [
      check("mentions app.js", mentionsApp, 2, response.slice(0, 200)),
      check("mentions config.js", mentionsConfig, 2),
      check("correctly excludes utils.js", correctlyExcludes, 2),
      check("used grep tool", events.anyToolCalled(["grep"]), 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
