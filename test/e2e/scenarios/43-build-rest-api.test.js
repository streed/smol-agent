import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, readResult, fileExists, cleanup,
} from "../harness.js";
import { config } from "../config.js";
import { buildActionLog, llmJudge } from "../llm-judge.js";

export const meta = { name: "build-rest-api", timeout: config.timeouts.complex, category: "code-gen", evalType: "capability", difficulty: "complex" };

const TASK_PROMPT = `Create a Node.js HTTP server using only built-in modules, listening on port 4200, with these endpoints:
- GET / → responds with plain text "Welcome to the API"
- GET /time → responds with JSON containing a "time" key with the current ISO timestamp
- GET /headers → responds with JSON echoing back the request headers
- Any other route → 404 response

Start the server, then curl all 3 endpoints to verify they work.`;

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);

  try {
    const _response = await runWithTimeout(agent, TASK_PROMPT, meta.timeout);

    const content = (await readResult(tmpDir, "server.js")) || "";

    // Deterministic checks
    const serverCreated = fileExists(tmpDir, "server.js");
    const didRun = events.toolCallCount("run_command") >= 1;
    const didWrite = events.anyToolCalled(["write_file"]);

    // LLM judge for semantic checks
    const actionLog = buildActionLog(events);
    const judgeChecks = await llmJudge(
      config,
      TASK_PROMPT,
      actionLog,
      [
        { name: "uses built-in http module", weight: 1, question: "Does the server use Node's built-in 'http' module (not express or other frameworks)?" },
        { name: "has root route returning Welcome", weight: 1, question: "Does GET / respond with 'Welcome to the API'?" },
        { name: "has /time route with timestamp", weight: 1, question: "Does GET /time respond with JSON containing a 'time' key?" },
        { name: "has /headers route echoing headers", weight: 1, question: "Does GET /headers respond with JSON echoing the request headers?" },
        { name: "has 404 handling", weight: 1, question: "Do unknown routes get a 404 response?" },
        { name: "got Welcome response from test", weight: 2, question: "Did the agent's HTTP test of / return a response containing 'Welcome to the API'?" },
        { name: "got timestamp in test output", weight: 2, question: "Did the agent's HTTP test of /time return a response containing an ISO timestamp (like 2024-01-15T...)?" },
        { name: "got headers in test output", weight: 2, question: "Did the agent's HTTP test of /headers return a response containing header names like 'host' or 'user-agent'?" },
      ],
      { "server.js": content },
    );

    return scoreResult(meta.name, [
      check("server.js created", serverCreated, 1),
      check("ran commands", didRun, 1),
      check("wrote file", didWrite, 1),
      ...judgeChecks,
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
