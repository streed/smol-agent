import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, fileExists, readResult, listFiles, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "multi-file-create", timeout: config.timeouts.complex, category: "file-ops", evalType: "regression", difficulty: "complex" };

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
    const fmtContent = (await readResult(tmpDir, "src/formatter.js")) || "";
    const mainContent = (await readResult(tmpDir, "main.js")) || "";

    // Verify calculator has actual function definitions, not just the word "add"
    const hasAddFn = /function\s+add|const\s+add\s*=|add\s*[:(]/.test(calcContent);
    const hasSubtractFn = /function\s+subtract|const\s+subtract\s*=|subtract\s*[:(]/.test(calcContent);
    const hasMultiplyFn = /function\s+multiply|const\s+multiply\s*=|multiply\s*[:(]/.test(calcContent);
    const hasAllFns = hasAddFn && hasSubtractFn && hasMultiplyFn;

    // Verify formatter has formatResult function
    const hasFormatResult = /function\s+formatResult|const\s+formatResult\s*=|formatResult/.test(fmtContent);

    // Verify main.js imports from the other modules
    const mainImportsCalc = /require\s*\(.*calculator|import.*calculator/i.test(mainContent);

    const files = await listFiles(tmpDir);
    const fileCount = files.filter((f) => f.endsWith(".js")).length;

    // Check that command output (not just response) contains 15
    const runResults = events.resultsFor("run_command")
      .map(r => [r?.stdout, r?.output, r?.content].filter(Boolean).join("\n")).join("\n");
    const outputHas15 = /\b15\b/.test(runResults);
    const responseHas15 = response.includes("15");
    const ranIt = events.anyToolCalled(["run_command"]);

    return scoreResult(meta.name, [
      check("calculator.js exists", calcExists, 2),
      check("formatter.js exists", fmtExists, 1),
      check("main.js exists", mainExists, 1),
      check("calculator has function definitions", hasAllFns, 2, calcContent.slice(0, 160)),
      check("formatter has formatResult", hasFormatResult, 1),
      check("main.js imports calculator", mainImportsCalc, 1),
      check("created 3+ JS files", fileCount >= 3, 1, `${fileCount} JS files: ${files.join(", ")}`),
      check("ran the program", ranIt, 2),
      check("command output contains 15", outputHas15 || responseHas15, 3, runResults.slice(-160) || response.slice(0, 160)),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
