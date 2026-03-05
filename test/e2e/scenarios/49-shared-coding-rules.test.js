/**
 * Scenario 49 — Shared coding rules
 *
 * Tests that the agent detects and follows shared coding rule files
 * (like .cursorrules) that are used by other development tools.
 */
import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, readResult, fileExists, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "shared-coding-rules", timeout: config.timeouts.medium };

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);

  // Seed a .cursorrules file with specific conventions
  await seedFile(tmpDir, ".cursorrules", `# Project Coding Rules
- Always use TypeScript-style JSDoc annotations on exported functions
- Use const for all variable declarations (never let or var)
- Error messages must start with "Error:" prefix
- All functions must have a single return statement (no early returns)
`);

  try {
    const response = await runWithTimeout(
      agent,
      'Create a file parser.js with a function parseJSON(str) that parses a JSON string and returns the result, or returns null if parsing fails.',
      meta.timeout,
    );

    const exists = fileExists(tmpDir, "parser.js");
    const content = (await readResult(tmpDir, "parser.js")) || "";

    // Check that rules were followed
    const usesConst = /\bconst\b/.test(content);
    const usesLetVar = /\b(let|var)\b/.test(content);
    const hasJSDoc = /\/\*\*[\s\S]*?\*\//.test(content);
    const hasParseJSON = /parseJSON/.test(content);
    const hasExport = /module\.exports|export\s/.test(content);

    return scoreResult(meta.name, [
      check("file exists", exists, 2),
      check("has parseJSON function", hasParseJSON, 2),
      check("uses const declarations", usesConst && !usesLetVar, 2, content.slice(0, 200)),
      check("has JSDoc annotation", hasJSDoc, 2),
      check("has export", hasExport, 1),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
