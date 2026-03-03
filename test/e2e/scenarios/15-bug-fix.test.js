import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "bug-fix", timeout: config.timeouts.complex };

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
    // The fix: i < n → i <= n (or equivalent restructuring)
    const bugFixed = content.includes("<= n") || content.includes("< n + 1") ||
      // Model might rewrite the loop entirely — check if the algorithm is correct
      (!content.includes("i < n;") && content.includes("fibonacci"));

    const didRead = events.anyToolCalled(["read_file"]);
    const didEdit = events.anyToolCalled(["replace_in_file", "write_file"]);
    const didRun = events.anyToolCalled(["run_command"]);
    const mentionsEight = response.includes("8");

    return scoreResult(meta.name, [
      check("bug fixed", bugFixed, 3, content.match(/for\s*\([^)]+\)/)?.[0] || content.slice(0, 120)),
      check("read file first", didRead, 1),
      check("edited file", didEdit, 2),
      check("ran to verify", didRun, 2),
      check("response mentions correct answer 8", mentionsEight, 2, response.slice(0, 160)),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
