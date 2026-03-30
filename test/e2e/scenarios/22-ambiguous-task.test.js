import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "ambiguous-task", timeout: config.timeouts.complex, category: "agent-behavior", evalType: "capability", difficulty: "complex" };

const SEED_SERVER = `const http = require("http");

const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("OK");
});

server.listen(3000);
`;

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);
  await seedFile(tmpDir, "server.js", SEED_SERVER);

  try {
    // Deliberately vague — the agent should explore first, then make reasonable improvements
    const response = await runWithTimeout(
      agent,
      "This server needs some improvements. Add proper error handling and make it more robust.",
      meta.timeout,
    );

    const content = (await readResult(tmpDir, "server.js")) || "";

    // The agent should have at least read the file before modifying
    const didExplore = events.anyToolCalled(["read_file", "list_files"]);
    const didEdit = events.anyToolCalled(["replace_in_file", "write_file"]);

    // Check for common "robustness" improvements an LLM would add
    const hasErrorHandling = /\.on\s*\(\s*['"]error['"]|try\s*\{|catch\s*\(|process\.on/.test(content);
    const hasImprovement = content.length > SEED_SERVER.length;
    const stillFunctions = content.includes("createServer") && content.includes("listen");

    // Response should explain what was changed
    const responseExplains = response.length > 30 && /error|handling|robust|improve/i.test(response);

    return scoreResult(meta.name, [
      check("explored before editing", didExplore, 2),
      check("made edits", didEdit, 2),
      check("added error handling", hasErrorHandling, 3, content.slice(0, 200)),
      check("code is longer (improved)", hasImprovement, 1, `${SEED_SERVER.length} → ${content.length} chars`),
      check("server still functional", stillFunctions, 2),
      check("response explains changes", responseExplains, 1, response.slice(0, 150)),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
