import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, fileExists, readResult, listFiles, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "multi-file-create", timeout: config.timeouts.complex };

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);

  try {
    const response = await runWithTimeout(
      agent,
      `Create a small Node.js project with these files:
1. src/calculator.js — exports functions: add(a,b), subtract(a,b), multiply(a,b)
2. src/formatter.js — exports a function formatResult(op, a, b, result) that returns a string like "2 + 3 = 5"
3. main.js — requires both modules, computes add(10,5), formats and console.logs the result

Then run main.js and tell me the output.`,
      meta.timeout,
    );

    const calcExists = fileExists(tmpDir, "src/calculator.js");
    const fmtExists = fileExists(tmpDir, "src/formatter.js");
    const mainExists = fileExists(tmpDir, "main.js");

    const calcContent = (await readResult(tmpDir, "src/calculator.js")) || "";
    const hasAllFns = /add/.test(calcContent) && /subtract/.test(calcContent) && /multiply/.test(calcContent);

    const files = await listFiles(tmpDir);
    const fileCount = files.filter((f) => f.endsWith(".js")).length;

    const has15 = response.includes("15");
    const ranIt = events.anyToolCalled(["run_command"]);

    return scoreResult(meta.name, [
      check("calculator.js exists", calcExists, 2),
      check("formatter.js exists", fmtExists, 2),
      check("main.js exists", mainExists, 2),
      check("calculator has all functions", hasAllFns, 2, calcContent.slice(0, 160)),
      check("created 3+ JS files", fileCount >= 3, 1, `${fileCount} JS files: ${files.join(", ")}`),
      check("ran the program", ranIt, 2),
      check("output contains 15", has15, 3, response.slice(0, 160)),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
