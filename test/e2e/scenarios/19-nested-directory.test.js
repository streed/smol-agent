import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, fileExists, readResult, listFiles, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "nested-directory", timeout: config.timeouts.medium };

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);

  try {
    await runWithTimeout(
      agent,
      `Create the following file structure:
- src/components/Button.js — export a function Button that returns "<button>Click</button>"
- src/components/Input.js — export a function Input that returns "<input/>"
- src/pages/Home.js — import Button and Input, export function Home that returns both concatenated
Make sure all parent directories are created.`,
      meta.timeout,
    );

    const buttonExists = fileExists(tmpDir, "src/components/Button.js");
    const inputExists = fileExists(tmpDir, "src/components/Input.js");
    const homeExists = fileExists(tmpDir, "src/pages/Home.js");

    const homeContent = (await readResult(tmpDir, "src/pages/Home.js")) || "";
    const buttonContent = (await readResult(tmpDir, "src/components/Button.js")) || "";
    const inputContent = (await readResult(tmpDir, "src/components/Input.js")) || "";

    // Verify Home imports components with proper require/import syntax
    const homeImportsButton = /require\(.*Button|import.*Button/.test(homeContent);
    const homeImportsInput = /require\(.*Input|import.*Input/.test(homeContent);

    // Verify component files have function definitions and exports
    const buttonHasFunction = /function\s+Button|const\s+Button/.test(buttonContent);
    const _inputHasFunction = /function\s+Input|const\s+Input/.test(inputContent);
    const buttonHasExport = /module\.exports|export/.test(buttonContent);

    const allFiles = await listFiles(tmpDir);
    const hasDirStructure = allFiles.some((f) => f.includes("components/")) &&
      allFiles.some((f) => f.includes("pages/"));

    // Verify write_file was used (not just that files exist)
    const writeCount = events.toolCallCount("write_file");

    return scoreResult(meta.name, [
      check("Button.js exists at correct path", buttonExists, 2),
      check("Input.js exists at correct path", inputExists, 2),
      check("Home.js exists at correct path", homeExists, 2),
      check("Home imports Button", homeImportsButton, 2, homeContent.slice(0, 160)),
      check("Home imports Input", homeImportsInput, 2),
      check("Button.js has function definition", buttonHasFunction, 1),
      check("Button.js has export", buttonHasExport, 1),
      check("directory structure correct", hasDirStructure, 1, allFiles.join(", ")),
      check("created multiple files", writeCount >= 3, 1, `${writeCount} writes`),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
