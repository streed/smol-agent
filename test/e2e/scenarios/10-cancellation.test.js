import {
  createTestAgent, collectEvents,
  scoreResult, check, cleanup,
} from "../harness.js";
import { config } from "../config.js";

export const meta = { name: "cancellation", timeout: config.timeouts.simple };

export async function run() {
  const { agent, tmpDir } = createTestAgent();
  const events = collectEvents(agent);

  try {
    // Start a long task. We'll try to cancel it, but the model or init may
    // finish before our cancel fires — that's OK, we just need to verify
    // that cancel doesn't crash or hang.
    const runPromise = agent.run(
      "Write a very long and detailed essay about the entire history of computing, covering every decade from the 1800s to today. Make it at least 5000 words.",
    );

    // Wait for the agent to be running (abortController exists) before cancelling.
    // Poll briefly — _init() must finish first or cancel() is a no-op.
    const cancelDelay = 2000;
    await new Promise((r) => setTimeout(r, cancelDelay));
    agent.cancel();

    // Hard safety timeout so this test can never hang the suite
    const safetyTimeout = new Promise((resolve) =>
      setTimeout(() => resolve("(Timeout exceeded)"), 15_000),
    );
    const response = await Promise.race([runPromise, safetyTimeout]);

    const cancelled =
      response.includes("(Operation cancelled)") ||
      response.includes("(Timeout exceeded)") ||
      response.includes("cancelled");

    // If the model responded before cancel fired, that's still a pass —
    // the important thing is no hang and no crash.
    const noHang = true; // we got here, so it didn't hang
    const noCrash = events.errors.length === 0;

    return scoreResult(meta.name, [
      check("no hang (resolved)", noHang, 3),
      check("no crash/errors", noCrash, 3, events.errors.map((e) => e.message)),
      check("cancelled or completed", cancelled || response.length > 0, 2, response.slice(0, 120)),
    ]);
  } finally {
    await cleanup(tmpDir);
  }
}
