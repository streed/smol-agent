import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, fileExists, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "recursive-dir-stats", timeout: config.timeouts.complex, category: "code-gen", evalType: "capability", difficulty: "complex" };

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);

  // Seed a nested directory structure with various files
  await seedFile(tmpDir, "project/README.md", "# Test Project\nThis is a sample project.\n");
  await seedFile(tmpDir, "project/src/index.js", "console.log('hello');\nconsole.log('world');\n");
  await seedFile(tmpDir, "project/src/utils/helpers.js", "module.exports = { add: (a,b) => a+b };\n");
  await seedFile(tmpDir, "project/src/utils/format.js", "module.exports = { fmt: (x) => String(x) };\n");
  await seedFile(tmpDir, "project/tests/test1.js", "// test file 1\n");
  await seedFile(tmpDir, "project/tests/test2.js", "// test file 2 with more content for size variation\nconst x = 1;\nconst y = 2;\n");
  await seedFile(tmpDir, "project/data/config.json", '{"key": "value", "debug": false}\n');

  try {
    await runWithTimeout(
      agent,
      `Create a Node.js script called dir-stats.js that recursively walks a directory and outputs stats:
- Total number of files
- Total number of directories
- Total size in bytes
- Name and size of the largest file

The script should take a directory path as a command-line argument (default to current directory).
After creating it, run it on the "project" directory.`,
      meta.timeout,
    );

    const script = (await readResult(tmpDir, "dir-stats.js")) || "";
    const scriptExists = fileExists(tmpDir, "dir-stats.js");

    // Uses fs module
    const usesFs = /require\s*\(\s*["'](?:node:)?fs["']\)/.test(script) ||
      /import.*["'](?:node:)?fs["']/.test(script) ||
      /fs\./.test(script);

    // Has recursive approach — must actually read directory entries (not just have the word "recursive")
    const hasReaddir = /readdir(Sync)?\s*\(/.test(script);
    const hasRecursion = hasReaddir && (
      // Self-calling function or recursive: true option
      /function\s+\w+.*\{[\s\S]*?\1\s*\(/.test(script) ||
      /recursive:\s*true/.test(script) ||
      // Or uses a walk/traverse pattern
      /walk|traverse|scan|isDirectory/.test(script)
    );

    const didWrite = events.anyToolCalled(["write_file"]);
    const ranScript = events.anyToolCalled(["run_command"]);

    // Check output contains file count (we seeded 7 files)
    const runResults = events.resultsFor("run_command")
      .map(r => [r?.stdout, r?.stderr, r?.content].filter(Boolean).join("\n")).join("\n");
    // Check output reports file count — we seeded 7 files, accept nearby counts (6-8)
    const hasFileCount = /\b[6-8]\b/.test(runResults) && /files?/i.test(runResults);
    // Must report size with a unit (bytes, KB, etc.) alongside an actual number
    const hasSizeInfo = /\d+\s*(bytes?|[Kk][Bb]|[Bb])/i.test(runResults) || /size\s*:\s*\d+/i.test(runResults);
    // Largest file must name a specific file
    const hasLargestFile = (/largest|biggest|max/i.test(runResults) && /\.\w{2,4}\b/.test(runResults));

    return scoreResult(meta.name, [
      check("script created", scriptExists, 2),
      check("uses fs module", usesFs, 2, script.slice(0, 100)),
      check("has recursive approach", hasRecursion, 2, script.slice(0, 200)),
      check("wrote the file", didWrite, 1),
      check("ran the script", ranScript, 2),
      check("output has file count", hasFileCount, 3, runResults.slice(-300)),
      check("output has size info", hasSizeInfo, 2, runResults.slice(-300)),
      check("output mentions largest file", hasLargestFile, 2, runResults.slice(-300)),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
