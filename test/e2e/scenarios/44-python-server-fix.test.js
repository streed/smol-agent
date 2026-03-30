import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";
import { buildActionLog, llmJudge } from "../llm-judge.js";

export const meta = { name: "python-server-fix", timeout: config.timeouts.complex, category: "debugging", evalType: "capability", difficulty: "complex" };

const SEED_SERVER = `from http.server import BaseHTTPRequestHandler, HTTPServer
import jason
import sys

class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path == "/ping":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(jason.dumps({"message": "pong"}).encode())
            return

        if self.path == "/info":
            info = {
                "python_version": sys.version,
                "server": "custom-http",
                "endpoints": ["/ping", "/info"]
            }
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(jason.dumps(info))
            return

        self.send_response(404)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"Not Found")

if __name__ == "__main__":
    server = HTTPServer(("", 4300), Handler)
    print("Server running on port 4300")
    server.serve_forever()
`;

const TASK_PROMPT = "Run server.py — it crashes. Fix the bugs, start the server, then curl /ping (expect \"pong\") and /info (expect \"python_version\" in the response).";

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);
  await seedFile(tmpDir, "server.py", SEED_SERVER);

  try {
    const _response = await runWithTimeout(agent, TASK_PROMPT, meta.timeout);

    const content = (await readResult(tmpDir, "server.py")) || "";

    // Deterministic checks
    const didRun = events.toolCallCount("run_command") >= 1;
    const didRead = events.anyToolCalled(["read_file"]);
    const didEdit = events.anyToolCalled(["replace_in_file", "write_file"]);

    // LLM judge for semantic checks
    const actionLog = buildActionLog(events);
    const judgeChecks = await llmJudge(
      config,
      TASK_PROMPT,
      actionLog,
      [
        { name: "fixed import jason to json", weight: 3, question: "Did the agent fix 'import jason' to 'import json'?" },
        { name: "all jason refs replaced with json", weight: 1, question: "Are all references to 'jason' (jason.dumps, etc.) replaced with 'json' (json.dumps, etc.)?" },
        { name: "fixed .encode() on /info response", weight: 2, question: "Does the /info endpoint's wfile.write() call now include .encode() so the string is properly encoded to bytes?" },
        { name: "tested endpoints via HTTP", weight: 1, question: "Did the agent make HTTP requests (curl, wget, python requests, etc.) to test the /ping and /info endpoints?" },
        { name: "got pong in output", weight: 2, question: "Did the agent's HTTP test of /ping return a response containing 'pong'?" },
        { name: "got python_version in output", weight: 2, question: "Did the agent's HTTP test of /info return a response containing 'python_version'?" },
      ],
      { "server.py": content },
    );

    return scoreResult(meta.name, [
      check("ran commands", didRun, 1),
      check("read file", didRead, 1),
      check("edited file", didEdit, 1),
      ...judgeChecks,
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
