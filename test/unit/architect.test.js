/**
 * Tests that architectPass drives the provider abstraction (BaseLLMProvider.chatWithRetry)
 * rather than the legacy ollama client. The regression: non-ollama providers
 * (anthropic/openai-compatible) never set a `.client`, so the old code path
 * silently failed for them.
 */
import { describe, test, expect } from "@jest/globals";
import { architectPass } from "../../src/architect.js";

describe("architectPass with provider abstraction", () => {
  test("returns a plan from a provider that has no legacy .client", async () => {
    // No `.client` field — mirrors AnthropicProvider / OpenAICompatibleProvider.
    const provider = {
      model: "fake-model",
      async chatWithRetry() {
        return { message: { content: "PLAN: do X then Y", tool_calls: [] } };
      },
    };
    const plan = await architectPass(provider, "add feature Z", { cwd: process.cwd() });
    expect(plan).toContain("PLAN: do X then Y");
  });

  test("forwards maxTokens and the conversation to chatWithRetry", async () => {
    let captured = null;
    const provider = {
      model: "m",
      async chatWithRetry(messages, tools, signal, maxTokens) {
        captured = { messageCount: messages.length, maxTokens };
        return { message: { content: "final plan", tool_calls: [] } };
      },
    };
    const plan = await architectPass(provider, "task", { maxTokens: 12345 });
    expect(plan).toBe("final plan");
    expect(captured.maxTokens).toBe(12345);
    expect(captured.messageCount).toBeGreaterThanOrEqual(2); // system + user
  });

  test("surfaces a provider failure as a non-plan string (caller skips it)", async () => {
    const provider = {
      model: "m",
      async chatWithRetry() {
        throw new Error("boom");
      },
    };
    const plan = await architectPass(provider, "task", {});
    // architectPass catches and returns "(Architect failed: …)"; agent.js skips
    // anything starting with "(".
    expect(plan.startsWith("(")).toBe(true);
  });
});
