import { afterEach, beforeEach, describe, expect, it } from "@jest/globals";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Agent } from "../../src/agent.js";
import { createSession, saveSession } from "../../src/sessions.js";

const RUNTIME_CONTEXT = {
  tieredRouter: {
    baseUrl: "https://router.example/v1",
    workflowId: 42,
    protectionLevel: "protected",
  },
};

describe("Agent runtime context integration", () => {
  let cwd;
  let agents;

  beforeEach(async () => {
    cwd = await fs.mkdtemp(path.join(os.tmpdir(), "smol-agent-agent-runtime-"));
    agents = [];
  });

  afterEach(async () => {
    for (const agent of agents) {
      agent.destroy();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it("passes runtime context into the provider and new sessions", () => {
    const agent = new Agent({
      provider: "openai",
      apiKey: "test-key",
      jailDirectory: cwd,
      runtimeContext: RUNTIME_CONTEXT,
    });
    agents.push(agent);

    const session = agent.startSession("legal reviewer");

    expect(agent.llmProvider.baseURL).toBe("https://router.example/v1");
    expect(agent.llmProvider.defaultHeaders["X-Workflow-Id"]).toBe("42");
    expect(agent.llmProvider.defaultHeaders["X-Protection-Level"]).toBe("protected");
    expect(session.runtimeContext.tieredRouter.workflowId).toBe(42);
    expect(session.runtimeContext.tieredRouter.baseUrl).toBe("https://router.example/v1");
  });

  it("rehydrates provider routing and session metadata when resuming", async () => {
    const session = createSession("legal reviewer", RUNTIME_CONTEXT);
    await saveSession(cwd, session, [
      { role: "user", content: "Continue this workflow." },
      { role: "assistant", content: "Resuming." },
    ]);

    const agent = new Agent({
      provider: "openai",
      apiKey: "test-key",
      jailDirectory: cwd,
    });
    agents.push(agent);
    agent._init = async function initForTest() {
      this._initialized = true;
      this.messages = [{ role: "system", content: "Test system prompt" }];
    };

    const loaded = await agent.resumeSession(session.id);

    expect(loaded).toBe(true);
    expect(agent.getSession().runtimeContext.tieredRouter.workflowId).toBe(42);
    expect(agent.getSession().runtimeContext.tieredRouter.baseUrl).toBe("https://router.example/v1");
    expect(agent.llmProvider.baseURL).toBe("https://router.example/v1");
    expect(agent.llmProvider.defaultHeaders["X-Workflow-Id"]).toBe("42");
    expect(agent.llmProvider.defaultHeaders["X-Protection-Level"]).toBe("protected");
  });
});
