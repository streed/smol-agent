import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "bug-fix", timeout: config.timeouts.complex, category: "debugging", evalType: "capability", difficulty: "complex" };

// A function with an off-by-one bug: the loop condition should be <=, not <
const SEED_CODE = `function fibonacci(n) {
  if (n <= 0) return 0;
  if (n === 1) return 1;
  let a = 0, b = 1;
  for (let i = 2; i < n; i++) {  // BUG: should be i <= n
    const temp = a + b;
    a = b;
    b = temp;
  }
  return b;
}

// fibonacci(6) should return 8, but currently returns 5
console.log("fib(6) =", fibonacci(6));

module.exports = { fibonacci };
`;

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);
  await seedFile(tmpDir, "fib.js", SEED_CODE);

  try {
    const response = await runWithTimeout(
      agent,
      "There's a bug in fib.js — fibonacci(6) should return 8 but it returns 5. Find and fix the bug, then run the file to verify.",
      meta.timeout,
    );

    const content = (await readResult(tmpDir, "fib.js")) || "";

    // The fix: the original bug is "i < n" which should be "i <= n"
    const hasCorrectBound = /i\s*<=\s*n/.test(content) || /i\s*<\s*n\s*\+\s*1/.test(content);
    const originalBugRemoved = !/for\s*\([^)]*i\s*<\s*n\s*;/.test(content);
    const bugFixed = hasCorrectBound || (originalBugRemoved && /fibonacci/.test(content));

    const didRead = events.anyToolCalled(["read_file"]);
    const didEdit = events.anyToolCalled(["replace_in_file", "write_file"]);
    const didRun = events.anyToolCalled(["run_command"]);

    // Check command output for "8", not just the response (which could say "8" in other context)
    const runResults = events.resultsFor("run_command")
      .map(r => [r?.stdout, r?.output, r?.content].filter(Boolean).join("\n")).join("\n");
    const outputHasEight = /\b8\b/.test(runResults);
    const responseHasEight = /fib.*8|fibonacci.*8|\b8\b/.test(response);

    return scoreResult(meta.name, [
      check("bug fixed (loop bound corrected)", bugFixed, 3, content.match(/for\s*\([^)]+\)/)?.[0] || content.slice(0, 120)),
      check("read file first", didRead, 1),
      check("edited file", didEdit, 2),
      check("ran to verify", didRun, 2),
      check("output shows correct answer 8", outputHasEight || responseHasEight, 2, (runResults || response).slice(0, 160)),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
