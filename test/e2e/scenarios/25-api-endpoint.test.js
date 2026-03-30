import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "api-endpoint", timeout: config.timeouts.complex, category: "code-gen", evalType: "capability", difficulty: "complex" };

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
    await runWithTimeout(
      agent,
      "Add a GET /api/status endpoint that returns JSON with { status: 'ok', timestamp: <current-time> }",
      meta.timeout,
    );

    const content = (await readResult(tmpDir, "server.js")) || "";

    const didRead = events.anyToolCalled(["read_file"]);
    const didEdit = events.anyToolCalled(["replace_in_file", "write_file"]);

    // Check for routing logic — must check request URL
    const hasUrlCheck = /req\.url/.test(content);
    const hasStatusEndpoint = /["']\/api\/status["']/.test(content);

    // Check for JSON response setup
    const hasJSONContentType = /["']application\/json["']/.test(content);

    // Status "ok" should be in a JSON object, not just anywhere
    const hasStatusOk = /["']status["']\s*:\s*["']ok["']/.test(content) ||
      /status:\s*["']ok["']/.test(content);

    // Timestamp should use Date constructor or toISOString, not just the word "timestamp"
    const hasTimestamp = /new\s+Date\s*\(/.test(content) || /Date\.now\s*\(/.test(content) ||
      /\.toISOString\s*\(/.test(content);

    // JSON.stringify should be used to serialize the response
    const usesJSONStringify = /JSON\.stringify/.test(content);

    // Server still works
    const stillListens = /listen\s*\(\s*3000/.test(content);

    return scoreResult(meta.name, [
      check("read server file", didRead, 1),
      check("made edits", didEdit, 1),
      check("checks req.url for routing", hasUrlCheck, 2, content.slice(0, 150)),
      check("handles /api/status path", hasStatusEndpoint, 2),
      check("sets application/json content-type", hasJSONContentType, 2),
      check("includes status: ok in response", hasStatusOk, 1),
      check("generates timestamp with Date", hasTimestamp, 1),
      check("uses JSON.stringify", usesJSONStringify, 1),
      check("server still listens on 3000", stillListens, 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
