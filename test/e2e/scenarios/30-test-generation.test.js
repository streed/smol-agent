import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "test-generation", timeout: config.timeouts.complex, category: "code-gen", evalType: "capability", difficulty: "complex" };

const SEED_CODE = `function fibonacci(n) {
  if (n <= 1) return n;
  return fibonacci(n - 1) + fibonacci(n - 2);
}

function isPrime(num) {
  if (num <= 1) return false;
  if (num <= 3) return true;
  if (num % 2 === 0 || num % 3 === 0) return false;

  for (let i = 5; i * i <= num; i += 6) {
    if (num % i === 0 || num % (i + 2) === 0) return false;
  }
  return true;
}

module.exports = { fibonacci, isPrime };
`;

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);
  await seedFile(tmpDir, "math.js", SEED_CODE);

  try {
    await runWithTimeout(
      agent,
      "Create a test file math.test.js with test cases for both functions",
      meta.timeout,
    );

    const testContent = (await readResult(tmpDir, "math.test.js")) || "";

    const didRead = events.anyToolCalled(["read_file"]);
    const didWrite = events.anyToolCalled(["write_file"]);

    // Test file created
    const testFileExists = testContent.length > 0;

    // Imports the module
    const importsMath = /require\(['"]\.\/math['"]/.test(testContent) ||
                       /import.*['"]\.\/math['"]/.test(testContent);

    // Has test structure
    const hasTestCases = /test\(|it\(|describe\(/.test(testContent) ||
                        /assert|expect/.test(testContent);

    // Tests both functions
    const testsFibonacci = /fibonacci/.test(testContent);
    const testsPrime = /isPrime|prime/.test(testContent);

    // Multiple test cases — count distinct test/it/assert calls
    const testCount = (testContent.match(/test\(|it\(|assert\./g) || []).length;
    const hasMultipleTests = testCount >= 3;

    // Check for edge case coverage — fibonacci(0), fibonacci(1), isPrime(1), isPrime(2)
    const testsEdgeCases = /fibonacci\s*\(\s*0\s*\)|fibonacci\s*\(\s*1\s*\)|isPrime\s*\(\s*1\s*\)|isPrime\s*\(\s*2\s*\)/.test(testContent);

    return scoreResult(meta.name, [
      check("read source file", didRead, 1),
      check("created test file", didWrite, 2),
      check("test file has content", testFileExists, 1),
      check("imports math module", importsMath, 2, testContent.slice(0, 100)),
      check("uses test framework", hasTestCases, 2),
      check("tests fibonacci", testsFibonacci, 1),
      check("tests isPrime", testsPrime, 1),
      check("multiple test cases", hasMultipleTests, 2, `found ${testCount} tests`),
      check("includes edge cases", testsEdgeCases, 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
