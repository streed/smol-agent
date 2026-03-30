/**
 * E2E test: Multi-file Express server refactoring.
 *
 * Scenario: Agent is given a Node.js HTTP server with multiple route files.
 * Must understand the server architecture, fix bugs in routes, and verify
 * endpoints work correctly. Tests multi-file codebase navigation.
 *
 * Dependencies: ../config.js, ../llm-judge.js, http, ./routes/user-routes, ./routes/status
 */
import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";
import { buildActionLog, llmJudge } from "../llm-judge.js";

export const meta = { name: "multi-file-server", timeout: config.timeouts.complex, category: "code-gen", evalType: "capability", difficulty: "complex" };

const SEED_SERVER = `const http = require("http");
const { handleUsers } = require("./routes/user-routes");
const { getStatus } = require("./routes/status");

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/users") {
    handleUsers(req, res);
    return;
  }

  if (req.method === "GET" && req.url === "/status") {
    getStatus(req, res);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

server.listen(4400, () => {
  console.log("Server running on port 4400");
});
`;

const SEED_USERS = `function getUsers(req, res) {
  const users = [
    { id: 1, name: "Alice", role: "admin" },
    { id: 2, name: "Bob", role: "user" },
    { id: 3, name: "Charlie", role: "user" },
  ];
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ users }));
}

modules.exports = { getUsers };
`;

const SEED_STATUS = `function getStatus(req, res) {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: "running",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  }));
}

module.exports = { getStatus };
`;

const TASK_PROMPT = "Run server.js — it crashes. Explore the project, fix all the wiring issues between files, start the server, then curl /users and /status to verify they work.";

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);
  await seedFile(tmpDir, "server.js", SEED_SERVER);
  await seedFile(tmpDir, "routes/users.js", SEED_USERS);
  await seedFile(tmpDir, "routes/status.js", SEED_STATUS);

  try {
    const _response = await runWithTimeout(agent, TASK_PROMPT, meta.timeout);

    const serverContent = (await readResult(tmpDir, "server.js")) || "";
    const usersContent = (await readResult(tmpDir, "routes/users.js")) || "";
    const statusContent = (await readResult(tmpDir, "routes/status.js")) || "";

    // Deterministic checks
    const didRun = events.toolCallCount("run_command") >= 1;
    const didReadMultiple = events.toolCallCount("read_file") >= 2 ||
      events.toolCallCount("list_files") >= 1;
    const didEdit = events.anyToolCalled(["replace_in_file", "write_file"]);

    // LLM judge for semantic checks
    const actionLog = buildActionLog(events);
    const judgeChecks = await llmJudge(
      config,
      TASK_PROMPT,
      actionLog,
      [
        { name: "fixed require path for users", weight: 3, question: "Did the agent fix the mismatch between require('./routes/user-routes') in server.js and the actual file being routes/users.js? (Either by changing the require path or renaming the file)" },
        { name: "fixed export/import name mismatch", weight: 2, question: "Did the agent fix the mismatch between server.js expecting 'handleUsers' and users.js exporting 'getUsers'? (Either by renaming the export or the import)" },
        { name: "fixed modules.exports typo", weight: 3, question: "Did the agent fix 'modules.exports' to 'module.exports' in users.js?" },
        { name: "tested endpoints via HTTP", weight: 1, question: "Did the agent make HTTP requests (curl, wget, node http.get, fetch, etc.) to test the /users and /status endpoints?" },
        { name: "got users data in output", weight: 2, question: "Did the agent's HTTP test of /users return a response containing user data (like 'Alice')?" },
        { name: "got status data in output", weight: 2, question: "Did the agent's HTTP test of /status return a response containing status info (like 'running')?" },
      ],
      {
        "server.js": serverContent,
        "routes/users.js": usersContent,
        "routes/status.js": statusContent,
      },
    );

    return scoreResult(meta.name, [
      check("ran commands", didRun, 1),
      check("read multiple files", didReadMultiple, 1),
      check("edited files", didEdit, 1),
      ...judgeChecks,
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
