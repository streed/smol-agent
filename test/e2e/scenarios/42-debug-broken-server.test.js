import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";
import { buildActionLog, llmJudge } from "../llm-judge.js";

export const meta = { name: "debug-broken-server", timeout: config.timeouts.complex, category: "debugging", evalType: "capability", difficulty: "complex" };

const SEED_SERVER = `const http = require("http");

const server = http.createSever((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(JSON.stringify({ status: "ok", uptime: process.uptime() }));
    return;
  }

  if (req.method === "POST" && req.url === "/echo") {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ echo: body }));
    req.on("end", () => {});
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
});

server.listen(4100, () => {
  console.log("Server running on port 4100");
});
`;

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);
  await seedFile(tmpDir, "server.js", SEED_SERVER);

  try {
    const _response = await runWithTimeout(
      agent,
      "Run server.js — it has bugs. Fix them all, start the server, then curl GET /health and verify the JSON response contains \"status\": \"ok\".",
      meta.timeout,
    );

    const content = (await readResult(tmpDir, "server.js")) || "";

    // Deterministic checks
    const didRun = events.toolCallCount("run_command") >= 1;
    const didRead = events.anyToolCalled(["read_file"]);
    const didEdit = events.anyToolCalled(["replace_in_file", "write_file"]);

    // LLM judge for semantic checks
    const actionLog = buildActionLog(events);
    const judgeChecks = await llmJudge(
      config,
      "Run server.js — it has bugs. Fix them all, start the server, then curl GET /health and verify the JSON response contains \"status\": \"ok\".",
      actionLog,
      [
        { name: "fixed createServer typo", weight: 3, question: "Did the agent fix the 'createSever' typo to 'createServer'?" },
        { name: "fixed content-type to application/json", weight: 2, question: "Does the /health endpoint now use 'application/json' as the Content-Type instead of 'text/plain'?" },
        { name: "fixed echo endpoint body handling", weight: 2, question: "Does the /echo endpoint now read the full request body before sending the response (i.e., res.end is called inside the req.on('end') callback)?" },
        { name: "tested endpoints via HTTP", weight: 2, question: "Did the agent make HTTP requests (curl, wget, node http.get, fetch, etc.) to test the server endpoints?" },
        { name: "got status ok in response", weight: 3, question: "Did the agent's HTTP test of /health return a response containing '\"status\": \"ok\"' or similar?" },
      ],
      { "server.js": content },
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
