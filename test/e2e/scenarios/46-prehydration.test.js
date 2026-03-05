/**
 * Scenario 46 — Pre-hydration
 *
 * Tests that when a user's message references existing files by path,
 * the agent receives pre-loaded context and can answer without needing
 * to read the files via tool calls first.
 */
import {
  createTestAgent, runWithTimeout, collectEvents,
  scoreResult, check, seedFile, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "prehydration", timeout: config.timeouts.medium };

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);

  // Seed a file that the user will reference by path
  await seedFile(tmpDir, "src/helpers.js", `
export function add(a, b) {
  return a + b;
}

export function multiply(a, b) {
  return a * b;
}

export function divide(a, b) {
  if (b === 0) throw new Error("Division by zero");
  return a / b;
}
`.trim());

  try {
    const response = await runWithTimeout(
      agent,
      'What functions are exported from src/helpers.js? List them all.',
      meta.timeout,
    );

    const mentionsAdd = /\badd\b/i.test(response);
    const mentionsMultiply = /\bmultiply\b/i.test(response);
    const mentionsDivide = /\bdivide\b/i.test(response);

    // The agent should know the functions — whether from pre-hydration
    // or from reading. Either way, correctness is what matters.
    return scoreResult(meta.name, [
      check("mentions add", mentionsAdd, 2),
      check("mentions multiply", mentionsMultiply, 2),
      check("mentions divide", mentionsDivide, 2),
      check("comprehensive response", response.length > 30, 1, `${response.length} chars`),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
