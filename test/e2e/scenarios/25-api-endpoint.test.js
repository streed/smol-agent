import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "api-endpoint", timeout: config.timeouts.complex };

const SEED_SERVER = `const http = require("http");

const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Hello World");
});

server.listen(3000);
module.exports = { server };
`;

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);
  await seedFile(tmpDir, "server.js", SEED_SERVER);

  try {
    const response = await runWithTimeout(
      agent,
      "Add a GET /api/status endpoint that returns JSON with { status: 'ok', timestamp: <current-time> }",
      meta.timeout,
    );

    const content = (await readResult(tmpDir, "server.js")) || "";

    const didRead = events.anyToolCalled(["read_file"]);
    const didEdit = events.anyToolCalled(["replace_in_file", "write_file"]);

    // Check for routing logic
    const hasRouting = /req\.url|req\.method/.test(content);
    const hasStatusEndpoint = /\/api\/status/.test(content);

    // Check for JSON response
    const hasJSONContentType = /application\/json/.test(content);
    const hasStatusOk = /status.*ok|["']status["']:\s*["']ok["']/.test(content);
    const hasTimestamp = /timestamp|Date|toISOString/.test(content);

    // Server still works
    const stillListens = /listen\s*\(\s*3000/.test(content);

    return scoreResult(meta.name, [
      check("read server file", didRead, 1),
      check("made edits", didEdit, 1),
      check("added routing logic", hasRouting, 2, content.slice(0, 150)),
      check("handles /api/status", hasStatusEndpoint, 2),
      check("sets JSON content-type", hasJSONContentType, 2),
      check("includes status: ok", hasStatusOk, 1),
      check("includes timestamp", hasTimestamp, 1),
      check("server still listens on 3000", stillListens, 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
