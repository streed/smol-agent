import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, readResult, fileExists, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "build-cli-tool", timeout: config.timeouts.complex, category: "code-gen", evalType: "capability", difficulty: "complex" };

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);

  try {
    await runWithTimeout(
      agent,
      `Create a bash script called wordcount.sh that works like a simplified 'wc' command.
It should:
1. Take a filename as its first argument
2. Print the line count, word count, and character count of that file
3. Output format: "Lines: N  Words: N  Chars: N"
4. Print an error message and exit with code 1 if no file argument is given or if the file doesn't exist

After creating the script, create a sample.txt file with some text content (at least 3 lines), make the script executable, and run it on sample.txt to show the output.`,
      meta.timeout,
    );

    const script = (await readResult(tmpDir, "wordcount.sh")) || "";
    const sampleContent = (await readResult(tmpDir, "sample.txt")) || "";

    const scriptExists = fileExists(tmpDir, "wordcount.sh");
    const sampleExists = fileExists(tmpDir, "sample.txt");

    // Script starts with shebang
    const hasShebang = /^#!.*\b(bash|sh)\b/.test(script);

    // Script handles file argument (references $1 or similar)
    const handlesArg = /\$1|\$\{1\}|"\$1"/.test(script);

    // Script has some form of error handling for missing args
    const hasErrorCheck = /if\s|test\s|\[\s/.test(script) || /-z\s/.test(script) || /-f\s/.test(script);

    // Script computes counts (uses wc, or manual counting with grep -c, awk, etc.)
    const computesCounts = /wc\b/.test(script) || /grep\s+-c/.test(script) ||
      /awk/.test(script) || /\$\(.*cat/.test(script);

    // Verify sample.txt has enough content for meaningful counts
    const sampleHasContent = sampleContent.split("\n").length >= 3;
    const ranCommand = events.anyToolCalled(["run_command"]);

    // Check that the script was actually executed and produced count output
    const runResults = events.resultsFor("run_command")
      .map(r => [r?.stdout, r?.stderr, r?.content].filter(Boolean).join("\n")).join("\n");
    const outputHasCounts = /\d+/.test(runResults) &&
      (/[Ll]ines?|[Ww]ords?|[Cc]hars?/.test(runResults) || /\d+\s+\d+\s+\d+/.test(runResults));

    return scoreResult(meta.name, [
      check("script created", scriptExists, 2),
      check("sample file created", sampleExists, 1),
      check("has shebang", hasShebang, 1, script.slice(0, 40)),
      check("handles file argument", handlesArg, 2, script.slice(0, 200)),
      check("has error checking", hasErrorCheck, 2),
      check("computes counts", computesCounts, 2, script.slice(0, 300)),
      check("sample.txt has 3+ lines", sampleHasContent, 1),
      check("ran the script", ranCommand, 2),
      check("output contains counts", outputHasCounts, 3, runResults.slice(-200)),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
