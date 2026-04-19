import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createSession, saveSession } from "../../src/sessions.js";
import { createInteractiveAgent } from "../../src/runtime/interactive-agent.js";

describe("createInteractiveAgent", () => {
  let cwd;
  let agents;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "smol-agent-interactive-"));
    agents = [];
  });

  afterEach(async () => {
    for (const agent of agents) {
      agent.destroy();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("resumes an existing session and rehydrates provider runtime context", async () => {
    const session = createSession("legal reviewer", {
      tieredRouter: {
        baseUrl: "https://router.example/v1",
        workflowId: 42,
        protectionLevel: "protected",
      },
    });

    await saveSession(cwd, session, [
      { role: "user", content: "Continue this workflow." },
    ]);

    const { agent, resumed } = await createInteractiveAgent({
      jailDirectory: cwd,
      provider: "openai",
      model: "gpt-4o",
      apiKey: "test-key",
      sessionId: session.id,
    });
    agents.push(agent);

    expect(resumed).toBe(true);
    expect(agent.llmProvider.baseURL).toBe("https://router.example/v1");
    expect(agent.getSession().runtimeContext.tieredRouter.workflowId).toBe(42);
  });

  it("passes programmaticToolCalling through to the created provider", async () => {
    const { agent } = await createInteractiveAgent({
      jailDirectory: cwd,
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      apiKey: "test-key",
      programmaticToolCalling: true,
    });
    agents.push(agent);

    expect(agent.llmProvider.programmaticToolCalling).toBe(true);
  });
});
