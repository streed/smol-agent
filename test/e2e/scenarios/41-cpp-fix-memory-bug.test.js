/**
 * E2E test: Fix C++ memory leak/buffer overflow.
 *
 * Scenario: Agent is given C++ code with multiple memory bugs:
 * - Buffer overflow (off-by-one error in loop bounds)
 * - Memory leak (missing delete for results array)
 * Agent must identify and fix these issues.
 *
 * Dependencies: ../config.js
 */
import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "cpp-fix-memory-bug", timeout: config.timeouts.complex, category: "debugging", evalType: "capability", difficulty: "complex" };

const SEED_CODE = `#include <iostream>
#include <cstring>

// Returns a dynamically allocated array of reversed copies of the input strings
char** reverseStrings(const char* inputs[], int count) {
    char** results = new char*[count];
    for (int i = 0; i <= count; i++) {
        int len = strlen(inputs[i]);
        results[i] = new char[len];
        for (int j = 0; j < len; j++) {
            results[i][j] = inputs[i][len - 1 - j];
        }
    }
    return results;
}

void freeResults(char** results, int count) {
    for (int i = 0; i < count; i++) {
        delete[] results[i];
    }
}

int main() {
    const char* words[] = {"hello", "world", "test"};
    int count = 3;

    char** reversed = reverseStrings(words, count);

    for (int i = 0; i < count; i++) {
        std::cout << words[i] << " -> " << reversed[i] << std::endl;
    }

    freeResults(reversed, count);

    std::cout << "All tests passed!" << std::endl;
    return 0;
}
`;

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);
  await seedFile(tmpDir, "reverse.cpp", SEED_CODE);

  try {
    await runWithTimeout(
      agent,
      "The file reverse.cpp has bugs — it may crash or produce garbled output. Read the code, identify the bugs, fix them, then compile with g++ and run it to verify it works correctly. The expected output should show each word reversed (hello -> olleh, world -> dlrow, test -> tset).",
      meta.timeout,
    );

    const content = (await readResult(tmpDir, "reverse.cpp")) || "";

    // Check bug fixes
    // BUG 1: loop bound fixed (i < count, not i <= count)
    const loopFixed = /i\s*<\s*count/.test(content) && !/i\s*<=\s*count/.test(content);

    // BUG 2: allocation includes space for null terminator (len + 1)
    const allocFixed = /new\s+char\s*\[\s*len\s*\+\s*1\s*\]/.test(content) ||
      /new\s+char\s*\[\s*len\s*\+\s*1\s*\]/.test(content) ||
      // Model may rewrite with std::string or other approach
      /std::string/.test(content);

    // BUG 3: null terminator added
    const nullTermFixed = /results\[i\]\[len\]\s*=\s*'\\0'/.test(content) ||
      /results\[i\]\[len\]\s*=\s*0/.test(content) ||
      /results\[i\]\[len\]\s*=\s*'\0'/.test(content) ||
      /std::string/.test(content);  // string class handles this

    // BUG 4: outer array freed
    const freeFixed = /delete\s*\[\]\s*results/.test(content) &&
      (content.match(/delete\s*\[\]/g) || []).length >= 2;

    const didRead = events.anyToolCalled(["read_file"]);
    const didEdit = events.anyToolCalled(["replace_in_file", "write_file"]);
    const ranCommand = events.anyToolCalled(["run_command"]);

    // Check that it compiled and ran successfully
    const runResults = events.resultsFor("run_command")
      .map(r => [r?.stdout, r?.stderr, r?.content].filter(Boolean).join("\n")).join("\n");
    const compiled = /g\+\+|clang/.test(
      events.tool_calls
        .filter((tc) => tc.name === "run_command")
        .map((tc) => JSON.stringify(tc.arguments))
        .join(" "),
    );
    const correctOutput = /hello\s*->\s*olleh/.test(runResults) &&
      /world\s*->\s*dlrow/.test(runResults);
    const ranSuccessfully = correctOutput || /All tests passed/.test(runResults);

    return scoreResult(meta.name, [
      check("read the file", didRead, 1),
      check("edited the file", didEdit, 2),
      check("loop bound fixed (i < count)", loopFixed, 3, content.match(/for\s*\([^)]+\)/)?.[0]),
      check("allocation includes null terminator space", allocFixed, 2),
      check("null terminator added or strings used", nullTermFixed, 2),
      check("outer array freed", freeFixed, 2),
      check("compiled with g++", compiled, 2),
      check("ran command to test", ranCommand, 1),
      check("ran successfully with correct output", ranSuccessfully, 3, runResults.slice(-300)),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
