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
    const importsComponents = /Button/.test(homeContent) && /Input/.test(homeContent);

    const allFiles = await listFiles(tmpDir);
    const hasDirStructure = allFiles.some((f) => f.includes("components/")) &&
      allFiles.some((f) => f.includes("pages/"));

    return scoreResult(meta.name, [
      check("Button.js exists at correct path", buttonExists, 2),
      check("Input.js exists at correct path", inputExists, 2),
      check("Home.js exists at correct path", homeExists, 2),
      check("Home imports both components", importsComponents, 3, homeContent.slice(0, 160)),
      check("directory structure correct", hasDirStructure, 2, allFiles.join(", ")),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
