import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "env-config", timeout: config.timeouts.medium, category: "code-transform", evalType: "regression", difficulty: "medium" };

const SEED_CONFIG = `const dbHost = "localhost";
const dbPort = 5432;
const apiKey = "hardcoded-secret-key";

module.exports = { dbHost, dbPort, apiKey };
`;

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);
  await seedFile(tmpDir, "config.js", SEED_CONFIG);

  try {
    await runWithTimeout(
      agent,
      "Move the hardcoded values to environment variables with process.env, and create a .env.example file showing the required variables",
      meta.timeout,
    );

    const configContent = (await readResult(tmpDir, "config.js")) || "";
    const envExampleContent = (await readResult(tmpDir, ".env.example")) || "";

    const didRead = events.anyToolCalled(["read_file"]);
    const didWrite = events.anyToolCalled(["write_file", "replace_in_file"]);

    // config.js uses process.env
    const usesProcessEnv = /process\.env\./.test(configContent);
    const dbHostFromEnv = /process\.env\.(DB_HOST|DATABASE_HOST)/.test(configContent);
    const apiKeyFromEnv = /process\.env\.API_KEY/.test(configContent);

    // .env.example created
    const envExampleExists = envExampleContent.length > 0;
    const hasDbHostExample = /DB_HOST|DATABASE_HOST/.test(envExampleContent);
    const hasApiKeyExample = /API_KEY/.test(envExampleContent);

    // Hardcoded values should be removed
    const _noHardcodedHost = !configContent.includes('"localhost"') || /process\.env/.test(configContent);
    const noHardcodedKey = !configContent.includes('"hardcoded-secret-key"');

    // Check for fallback/default values (good practice)
    const _hasDefaults = /\|\|/.test(configContent) || /\?\?/.test(configContent);

    return scoreResult(meta.name, [
      check("read config file", didRead, 1),
      check("made changes", didWrite, 1),
      check("uses process.env", usesProcessEnv, 2, configContent.slice(0, 150)),
      check("DB_HOST from env", dbHostFromEnv, 2),
      check("API_KEY from env", apiKeyFromEnv, 2),
      check("hardcoded secret removed", noHardcodedKey, 1),
      check("created .env.example", envExampleExists, 1),
      check("DB_HOST in example", hasDbHostExample, 1),
      check("API_KEY in example", hasApiKeyExample, 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
