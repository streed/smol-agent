/**
 * Unit tests for the provider factory and provider implementations.
 *
 * Covers createProvider() preset/custom-URL handling and tool-call
 * normalization edge cases:
 * - createProvider: Factory function for different providers
 * - listProviders: Listing available provider presets
 * - getDefaultModel: Getting default model for provider
 * - Provider-specific tool call normalization
 *
 * Dependencies: @jest/globals, ../../src/providers/index.js,
 *               ../../src/providers/ollama.js, ../../src/providers/openai-compatible.js,
 *               ../../src/providers/anthropic.js
 */
import { describe, test, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { createProvider, listProviders, getDefaultModel } from "../../src/providers/index.js";
import { OllamaProvider } from "../../src/providers/ollama.js";
import { OpenAICompatibleProvider } from "../../src/providers/openai-compatible.js";
import { AnthropicProvider } from "../../src/providers/anthropic.js";
import { CodexCLIProvider } from "../../src/providers/codex-cli.js";

// ── createProvider() ──────────────────────────────────────────────────────────

describe("createProvider()", () => {
  let savedEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
  });

  afterEach(() => {
    // Restore env
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
  });

  test("defaults to ollama when no provider specified", () => {
    delete process.env.SMOL_AGENT_PROVIDER;
    const p = createProvider({});
    expect(p).toBeInstanceOf(OllamaProvider);
  });

  test("creates OllamaProvider for 'ollama' preset", () => {
    const p = createProvider({ provider: "ollama" });
    expect(p).toBeInstanceOf(OllamaProvider);
  });

  test("preset matching is case-insensitive", () => {
    const p = createProvider({ provider: "OLLAMA" });
    expect(p).toBeInstanceOf(OllamaProvider);

    const p2 = createProvider({ provider: "OpenAI" });
    expect(p2).toBeInstanceOf(OpenAICompatibleProvider);
  });

  test("creates OpenAICompatibleProvider for 'openai' preset", () => {
    const p = createProvider({ provider: "openai", apiKey: "test-key" });
    expect(p).toBeInstanceOf(OpenAICompatibleProvider);
    expect(p.name).toBe("openai");
  });

  test("creates OpenAICompatibleProvider for 'grok' preset", () => {
    const p = createProvider({ provider: "grok", apiKey: "test-key" });
    expect(p).toBeInstanceOf(OpenAICompatibleProvider);
    expect(p.name).toBe("grok");
  });

  test("creates AnthropicProvider for 'anthropic' preset", () => {
    const p = createProvider({ provider: "anthropic", apiKey: "test-key" });
    expect(p).toBeInstanceOf(AnthropicProvider);
  });

  test("creates CodexCLIProvider for 'codex' preset", () => {
    const p = createProvider({ provider: "codex" });
    expect(p).toBeInstanceOf(CodexCLIProvider);
    expect(p.name).toBe("codex");
  });

  test("treats http:// value as custom OpenAI-compatible URL (preserves casing)", () => {
    const url = "http://localhost:1234/v1";
    const p = createProvider({ provider: url });
    expect(p).toBeInstanceOf(OpenAICompatibleProvider);
    expect(p.baseURL).toBe(url);
  });

  test("treats https:// value as custom OpenAI-compatible URL (preserves path casing)", () => {
    const url = "https://My-Custom-Host/API/v1";
    const p = createProvider({ provider: url });
    expect(p).toBeInstanceOf(OpenAICompatibleProvider);
    // The URL path casing must not be lowercased
    expect(p.baseURL).toContain("/API/v1");
  });

  test("uses SMOL_AGENT_PROVIDER env var when no provider option given", () => {
    process.env.SMOL_AGENT_PROVIDER = "anthropic";
    process.env.ANTHROPIC_API_KEY = "env-key";
    const p = createProvider({});
    expect(p).toBeInstanceOf(AnthropicProvider);
  });

  test("uses provider-specific env API key when no apiKey option given", () => {
    process.env.OPENAI_API_KEY = "env-openai-key";
    const p = createProvider({ provider: "openai" });
    expect(p.apiKey).toBe("env-openai-key");
  });

  test("explicit apiKey option takes precedence over env var", () => {
    process.env.OPENAI_API_KEY = "env-key";
    const p = createProvider({ provider: "openai", apiKey: "explicit-key" });
    expect(p.apiKey).toBe("explicit-key");
  });

  test("throws for unknown provider names", () => {
    expect(() => createProvider({ provider: "unknown-provider" })).toThrow(/Unknown provider/);
    expect(() => createProvider({ provider: "unknown-provider" })).toThrow("unknown-provider");
  });

  test("respects model option", () => {
    const p = createProvider({ provider: "openai", model: "gpt-4-turbo", apiKey: "k" });
    expect(p.model).toBe("gpt-4-turbo");
  });
});

// ── listProviders / getDefaultModel ──────────────────────────────────────────

describe("listProviders()", () => {
  test("includes all known preset names", () => {
    const providers = listProviders();
    expect(providers).toContain("ollama");
    expect(providers).toContain("openai");
    expect(providers).toContain("grok");
    expect(providers).toContain("anthropic");
    expect(providers).toContain("codex");
  });
});

describe("getDefaultModel()", () => {
  test("returns ollama default for unknown/null provider", () => {
    const model = getDefaultModel(null);
    expect(typeof model).toBe("string");
    expect(model.length).toBeGreaterThan(0);
  });

  test("returns gpt-4o for openai", () => {
    expect(getDefaultModel("openai")).toBe("gpt-4o");
  });

  test("returns grok-4-latest for grok", () => {
    expect(getDefaultModel("grok")).toBe("grok-4-latest");
  });

  test("returns gpt-5.4 for codex", () => {
    expect(getDefaultModel("codex")).toBe("gpt-5.4");
  });
});

// ── CodexCLIProvider ────────────────────────────────────────────────────────

describe("CodexCLIProvider", () => {
  test("streams assistant deltas from codex app-server and returns the final message", async () => {
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    const stdoutListeners = new Map();
    const stderrListeners = new Map();
    const writes = [];

    const child = {
      stdout: {
        on(event, handler) {
          stdoutListeners.set(event, handler);
        },
      },
      stderr: {
        on(event, handler) {
          stderrListeners.set(event, handler);
        },
      },
      stdin: {
        writable: true,
        write(chunk) {
          writes.push(JSON.parse(chunk.trim()));
        },
      },
      on() {},
      killed: false,
      kill() {},
    };

    const provider = new CodexCLIProvider({
      model: "gpt-5.4",
      cwd: "/tmp/project",
      spawnImpl: () => child,
      createInterfaceImpl: () => ({
        on(event, handler) {
          stdoutListeners.set(event, handler);
        },
        close() {},
      }),
    });

    const streamPromise = (async () => {
      const events = [];
      for await (const event of provider.chatStream(
        [
          { role: "system", content: "Be precise." },
          { role: "user", content: "Inspect the repo and summarize the current state." },
        ],
        [],
        null,
      )) {
        events.push(event);
      }
      return events;
    })();

    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe("initialize");

    stdoutListeners.get("line")(JSON.stringify({ id: writes[0].id, result: { ok: true } }));
    await flush();
    expect(writes).toHaveLength(3);
    expect(writes[1].method).toBe("initialized");
    expect(writes[2].method).toBe("thread/start");
    stdoutListeners.get("line")(
      JSON.stringify({
        id: writes[2].id,
        result: { thread: { id: "thread-123" } },
      }),
    );
    await flush();

    expect(writes).toHaveLength(4);
    expect(writes[3].method).toBe("turn/start");
    expect(writes[3].params.threadId).toBe("thread-123");

    stdoutListeners.get("line")(
      JSON.stringify({
        id: writes[3].id,
        result: { turn: { id: "turn-1" } },
      }),
    );
    await flush();

    stdoutListeners.get("line")(
      JSON.stringify({
        method: "item/agentMessage/delta",
        params: { turnId: "turn-1", delta: "Inspected " },
      }),
    );
    stdoutListeners.get("line")(
      JSON.stringify({
        method: "item/agentMessage/delta",
        params: { turnId: "turn-1", delta: "the repository." },
      }),
    );
    stdoutListeners.get("line")(
      JSON.stringify({
        method: "turn/completed",
        params: { turn: { id: "turn-1", status: "completed" } },
      }),
    );

    const events = await streamPromise;
    expect(events).toEqual([
      { type: "token", content: "Inspected " },
      { type: "token", content: "the repository." },
      {
        type: "done",
        toolCalls: [],
        tokenUsage: { promptTokens: 0, completionTokens: 0 },
      },
    ]);
  });
});

// ── OpenAICompatibleProvider._normalizeToolCalls ──────────────────────────────

describe("OpenAICompatibleProvider._normalizeToolCalls()", () => {
  let provider;

  beforeEach(() => {
    provider = new OpenAICompatibleProvider({ model: "gpt-4o", apiKey: "test" });
  });

  test("returns empty array for null/undefined input", () => {
    expect(provider._normalizeToolCalls(null)).toEqual([]);
    expect(provider._normalizeToolCalls(undefined)).toEqual([]);
    expect(provider._normalizeToolCalls([])).toEqual([]);
  });

  test("parses JSON string arguments", () => {
    const input = [{ id: "c1", function: { name: "read_file", arguments: '{"path":"foo.txt"}' } }];
    const result = provider._normalizeToolCalls(input);
    expect(result[0].function.arguments).toEqual({ path: "foo.txt" });
  });

  test("passes through object arguments unchanged", () => {
    const args = { path: "bar.txt" };
    const input = [{ id: "c1", function: { name: "read_file", arguments: args } }];
    const result = provider._normalizeToolCalls(input);
    expect(result[0].function.arguments).toEqual(args);
  });

  test("falls back to empty object for malformed JSON", () => {
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
    const input = [{ id: "c1", function: { name: "read_file", arguments: "{bad json" } }];
    const result = provider._normalizeToolCalls(input);
    expect(result[0].function.arguments).toEqual({});
    warnSpy.mockRestore();
  });

  test("preserves tool call id", () => {
    const input = [{ id: "call_abc", function: { name: "read_file", arguments: "{}" } }];
    const result = provider._normalizeToolCalls(input);
    expect(result[0].id).toBe("call_abc");
  });

  test("handles multiple tool calls", () => {
    const input = [
      { id: "c1", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
      { id: "c2", function: { name: "write_file", arguments: '{"path":"b.txt","content":"hi"}' } },
    ];
    const result = provider._normalizeToolCalls(input);
    expect(result).toHaveLength(2);
    expect(result[0].function.name).toBe("read_file");
    expect(result[1].function.arguments).toEqual({ path: "b.txt", content: "hi" });
  });
});

// ── OpenAICompatibleProvider._adaptMessagesForOpenAI ─────────────────────────

describe("OpenAICompatibleProvider._adaptMessagesForOpenAI()", () => {
  let provider;

  beforeEach(() => {
    provider = new OpenAICompatibleProvider({ model: "gpt-4o", apiKey: "test" });
  });

  test("returns non-array input unchanged", () => {
    expect(provider._adaptMessagesForOpenAI(null)).toBeNull();
    expect(provider._adaptMessagesForOpenAI("str")).toBe("str");
  });

  test("passes through messages without tool calls unchanged", () => {
    const msgs = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ];
    const result = provider._adaptMessagesForOpenAI(msgs);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(msgs[0]);
  });

  test("assigns IDs to tool calls that lack them", () => {
    const msgs = [
      { role: "user", content: "Do something" },
      { role: "assistant", content: "", tool_calls: [{ function: { name: "read_file", arguments: {} } }] },
      { role: "tool", content: "file contents" },
    ];
    const result = provider._adaptMessagesForOpenAI(msgs);
    const assistantMsg = result[1];
    expect(assistantMsg.tool_calls[0].id).toBeDefined();
    expect(typeof assistantMsg.tool_calls[0].id).toBe("string");
  });

  test("adds tool_call_id to tool messages matching the preceding assistant call", () => {
    const msgs = [
      { role: "user", content: "Do something" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_123", function: { name: "read_file", arguments: {} } }],
      },
      { role: "tool", content: "file contents" },
    ];
    const result = provider._adaptMessagesForOpenAI(msgs);
    const toolMsg = result[2];
    expect(toolMsg.tool_call_id).toBe("call_123");
  });

  test("preserves existing tool_call_id on tool messages", () => {
    const msgs = [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_abc", function: { name: "read_file", arguments: {} } }],
      },
      { role: "tool", content: "result", tool_call_id: "already_set" },
    ];
    const result = provider._adaptMessagesForOpenAI(msgs);
    expect(result[1].tool_call_id).toBe("already_set");
  });

  test("handles multiple tool calls correlating by name", () => {
    const msgs = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "id_read", function: { name: "read_file", arguments: {} } },
          { id: "id_write", function: { name: "write_file", arguments: {} } },
        ],
      },
      { role: "tool", name: "write_file", content: "write result" },
      { role: "tool", name: "read_file", content: "read result" },
    ];
    const result = provider._adaptMessagesForOpenAI(msgs);
    expect(result[1].tool_call_id).toBe("id_write");
    expect(result[2].tool_call_id).toBe("id_read");
  });

  test("preserves existing IDs on tool calls", () => {
    const msgs = [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "existing_id", function: { name: "read_file", arguments: {} } }],
      },
      { role: "tool", content: "result" },
    ];
    const result = provider._adaptMessagesForOpenAI(msgs);
    expect(result[0].tool_calls[0].id).toBe("existing_id");
    expect(result[1].tool_call_id).toBe("existing_id");
  });

  test("stringifies tool call arguments for OpenAI-compatible APIs", () => {
    const msgs = [
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "call_1", function: { name: "read_file", arguments: { path: "/src/index.js" } } },
          { id: "call_2", function: { name: "write_file", arguments: {} } },
        ],
      },
      { role: "tool", content: "result" },
    ];
    const result = provider._adaptMessagesForOpenAI(msgs);
    // Arguments must be JSON strings for OpenAI-compatible APIs (Groq, OpenAI, etc.)
    expect(result[0].tool_calls[0].function.arguments).toBe('{"path":"/src/index.js"}');
    expect(result[0].tool_calls[1].function.arguments).toBe('{}');
    // Should also include type: "function"
    expect(result[0].tool_calls[0].type).toBe("function");
  });

  test("handles arguments that are already strings", () => {
    const msgs = [
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "call_1", function: { name: "read_file", arguments: '{"path":"/src/index.js"}' } }],
      },
      { role: "tool", content: "result" },
    ];
    const result = provider._adaptMessagesForOpenAI(msgs);
    // Should pass through string arguments unchanged
    expect(result[0].tool_calls[0].function.arguments).toBe('{"path":"/src/index.js"}');
  });
});

// ── AnthropicProvider._headers ────────────────────────────────────────────────

describe("AnthropicProvider._headers()", () => {
  test("omits x-api-key when no API key configured", () => {
    const p = new AnthropicProvider({ model: "claude-sonnet-4-20250514" });
    const headers = p._headers();
    expect(headers["x-api-key"]).toBeUndefined();
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["anthropic-version"]).toBe("2023-06-01");
  });

  test("includes x-api-key when API key is set", () => {
    const p = new AnthropicProvider({ apiKey: "my-key", model: "claude-sonnet-4-20250514" });
    const headers = p._headers();
    expect(headers["x-api-key"]).toBe("my-key");
  });
});

// ── AnthropicProvider._convertMessages ───────────────────────────────────────

describe("AnthropicProvider._convertMessages()", () => {
  let provider;

  beforeEach(() => {
    provider = new AnthropicProvider({ apiKey: "test", model: "claude-sonnet-4-20250514" });
  });

  test("extracts system messages", () => {
    const msgs = [
      { role: "system", content: "System prompt." },
      { role: "user", content: "Hello" },
    ];
    const { system, messages } = provider._convertMessages(msgs);
    expect(system).toBe("System prompt.");
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
  });

  test("converts tool result messages to user role with tool_result block", () => {
    const msgs = [
      { role: "user", content: "Run something" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ id: "tu_123", function: { name: "read_file", arguments: { path: "f.txt" } } }],
      },
      { role: "tool", content: "file contents" },
    ];
    const { messages } = provider._convertMessages(msgs);
    const toolResultMsg = messages.find(m => m.role === "user" && Array.isArray(m.content));
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg.content[0].type).toBe("tool_result");
    expect(toolResultMsg.content[0].tool_use_id).toBe("tu_123");
    expect(toolResultMsg.content[0].content).toBe("file contents");
  });

  test("correlates tool results to assistant tool_use IDs in order", () => {
    const msgs = [
      { role: "user", content: "Do two things" },
      {
        role: "assistant",
        content: "",
        tool_calls: [
          { id: "id_a", function: { name: "tool_a", arguments: {} } },
          { id: "id_b", function: { name: "tool_b", arguments: {} } },
        ],
      },
      { role: "tool", content: "result a" },
      { role: "tool", content: "result b" },
    ];
    const { messages } = provider._convertMessages(msgs);
    // Both tool results become user messages with tool_result content
    const toolResults = messages.filter(
      m => m.role === "user" && Array.isArray(m.content) && m.content[0]?.type === "tool_result"
    );
    // They may be merged due to consecutive same-role merging
    const allResults = toolResults.flatMap(m => m.content);
    const ids = allResults.map(r => r.tool_use_id);
    expect(ids).toContain("id_a");
    expect(ids).toContain("id_b");
  });

  test("generates fallback IDs when tool calls have no id", () => {
    const msgs = [
      { role: "user", content: "Run" },
      {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name: "read_file", arguments: {} } }],
      },
      { role: "tool", content: "result" },
    ];
    const { messages } = provider._convertMessages(msgs);
    const toolResultMsg = messages.find(
      m => m.role === "user" && Array.isArray(m.content) && m.content[0]?.type === "tool_result"
    );
    expect(toolResultMsg).toBeDefined();
    const id = toolResultMsg.content[0].tool_use_id;
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    // The ID should not be "undefined" literally
    expect(id).not.toBe("undefined");
  });

  test("merges consecutive same-role messages", () => {
    const msgs = [
      { role: "user", content: "First" },
      { role: "user", content: "Second" },
    ];
    const { messages } = provider._convertMessages(msgs);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toContain("First");
    expect(messages[0].content).toContain("Second");
  });
});
