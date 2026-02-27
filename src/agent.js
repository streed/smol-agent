import { EventEmitter } from "node:events";
import * as ollama from "./ollama.js";
import * as registry from "./tools/registry.js";
import { gatherContext } from "./context.js";
import { logger } from "./logger.js";
import { estimateTokenCount } from "./conversation-summarizer.js";

// Import all tools so they self-register
import "./tools/run_command.js";
import "./tools/file_tools.js";
import "./tools/list_files.js";
import "./tools/grep.js";
import { setOllamaClient as setSearchClient } from "./tools/web_search.js";
import { setOllamaClient as setFetchClient } from "./tools/web_fetch.js";
import "./tools/ask_user.js";
import "./tools/plan_tools.js";
import "./tools/reflection.js";
import "./tools/create_tool.js";
import { loadCustomTools } from "./tools/create_tool.js";

/**
 * Attempt to extract tool calls from the assistant's text content.
 * Some models output tool calls as JSON instead of using Ollama's
 * native tool_calls field.  We try multiple patterns because different
 * model families format them differently.
 */
function parseToolCallsFromContent(content) {
  if (!content) return [];

  const calls = [];
  const candidates = [];

  // 1. Fenced JSON blocks (```json ... ``` or ``` ... ```)
  const jsonBlockRe = /```(?:json)?\s*\n?([\s\S]*?)\n?```/g;
  let match;
  while ((match = jsonBlockRe.exec(content)) !== null) {
    candidates.push(match[1].trim());
  }

  // 2. <tool_call> ... </tool_call> tags (used by some Qwen/Mistral models)
  const toolCallTagRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  while ((match = toolCallTagRe.exec(content)) !== null) {
    candidates.push(match[1].trim());
  }

  // 3. Bare JSON objects with "name" and "arguments" keys (nested braces handled)
  const bareJsonRe = /\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/g;
  while ((match = bareJsonRe.exec(content)) !== null) {
    candidates.push(match[0].trim());
  }

  // 4. Function-call style:  function_name({"key": "value"})
  const funcCallRe = /([a-z_][a-z0-9_]*)\((\{[\s\S]*?\})\)/gi;
  while ((match = funcCallRe.exec(content)) !== null) {
    const name = match[1];
    const argsStr = match[2].trim();
    try {
      const args = JSON.parse(argsStr);
      if (typeof args === "object") {
        calls.push({ function: { name, arguments: args } });
      }
    } catch { /* not valid JSON args */ }
  }

  for (const candidate of candidates) {
    try {
      let parsed = JSON.parse(candidate);
      // Handle arrays of tool calls
      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          if (item.name && typeof item.name === "string" && item.arguments && typeof item.arguments === "object") {
            calls.push({ function: { name: item.name, arguments: item.arguments } });
          }
        }
        continue;
      }
      if (parsed.name && typeof parsed.name === "string" &&
          parsed.arguments && typeof parsed.arguments === "object") {
        calls.push({
          function: { name: parsed.name, arguments: parsed.arguments },
        });
      }
      // Some models wrap in { "function": { "name": ..., "arguments": ... } }
      if (parsed.function?.name && parsed.function?.arguments) {
        calls.push({
          function: { name: parsed.function.name, arguments: parsed.function.arguments },
        });
      }
    } catch { /* not valid JSON */ }
  }

  return calls;
}

// ── System prompt ────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are smol-agent, a coding assistant that runs in the user's terminal.
You have direct access to the project through tools. Your job is to DO the work, not describe it.

IMPORTANT: Always use your tools to take action. Never just explain what you would do.

## Workflow

1. Explore: list_files, grep, read_file to understand the code.
2. Edit: replace_in_file for targeted changes, write_file for new files.
3. Verify: run_command to run tests/builds.
4. Respond briefly with what you did.

## Rules

- Act immediately. Do not ask for permission unless something is genuinely ambiguous.
- Use relative paths from the project root.
- Keep responses short — the user wants results, not essays.
- Prefer replace_in_file over write_file for existing files.
- Prefer file tools over shell commands for file operations.`;

/**
 * Detect if the model's text response looks like it's *describing* tool
 * usage rather than actually calling tools.  Common patterns:
 *   "I'll read the file…"  /  "Let me search for…"  /  "First, I need to…"
 *   "I would use replace_in_file…"  /  "Here's what I'll do:…"
 */
function looksLikeUnexecutedIntent(text) {
  if (!text || text.length < 20) return false;
  const lower = text.toLowerCase();

  // Phrases that indicate the model is narrating instead of acting
  const intentPhrases = [
    "i'll ", "i will ", "let me ", "i need to ", "i would ",
    "first, ", "let's ", "i can ", "i should ", "i'm going to ",
    "here's what", "here is what", "the next step",
    "we need to ", "we should ", "we can ",
  ];

  // Tool names that suggest the model knows which tool to use but didn't call it
  const toolMentions = [
    "read_file", "write_file", "replace_in_file", "list_files",
    "grep", "run_command",
  ];

  const hasIntent = intentPhrases.some((p) => lower.includes(p));
  const mentionsTool = toolMentions.some((t) => lower.includes(t));

  // If the response both sounds intentional AND mentions a tool name, it's
  // almost certainly a case where the model described instead of acted.
  // Also trigger if it's a very short "I'll do X" style response.
  return (hasIntent && mentionsTool) || (hasIntent && text.length < 200);
}

// ── Agent ────────────────────────────────────────────────────────────

export class Agent extends EventEmitter {
  constructor({ host, model, contextSize, jailDirectory, coreToolsOnly } = {}) {
    super();
    this.client = ollama.createClient(host);
    this.model = model || ollama.DEFAULT_MODEL;
    this.contextSize = contextSize;
    this.jailDirectory = jailDirectory || process.cwd();
    this.messages = [];
    this.running = false;
    this._initialized = false;
    this.abortController = null;
    this.readOnly = false;
    // When true, only expose ~7 core tools to the model (better for <30B models).
    // When false, expose all tools (fine for 30B+ models).
    this.coreToolsOnly = coreToolsOnly ?? true;

    // Token tracking — real counts from API when available
    this.lastPromptTokens = 0;
    this.maxTokens = 128000;

    setSearchClient(this.client);
    setFetchClient(this.client);
  }

  /** Toggle read-only mode (blocks write tools). */
  setReadOnly(enabled) {
    this.readOnly = !!enabled;
    return this.readOnly;
  }

  /** Get current token usage info. */
  getTokenInfo() {
    // Prefer real API counts; fall back to estimate
    const used = this.lastPromptTokens || estimateTokenCount(this.messages);
    const pct = Math.round((used / this.maxTokens) * 100);
    return { used, max: this.maxTokens, percentage: pct };
  }

  /**
   * Build the system message with project context.
   * Called once before the first run(), or after reset().
   */
  async _init() {
    if (this._initialized) return;

    let contextBlock = "";
    try {
      contextBlock = await gatherContext(this.jailDirectory, this.contextSize);
    } catch { /* proceed without context */ }

    // List extended tools so the model knows they exist but isn't overwhelmed
    const extended = registry.extendedToolNames();
    const extendedNote = extended.length > 0
      ? `\n\nAdditional tools available if needed: ${extended.join(", ")}`
      : "";

    const systemContent = contextBlock
      ? `${SYSTEM_PROMPT}${extendedNote}\n\n# Project context\n\n${contextBlock}`
      : `${SYSTEM_PROMPT}${extendedNote}`;

    this.messages = [{ role: "system", content: systemContent }];
    this._initialized = true;

    try { await loadCustomTools(); } catch (err) {
      console.warn("Failed to load custom tools:", err.message);
    }

    this.emit("context_ready");
  }

  /**
   * Send a user message and run the full tool-call loop with streaming
   * until the model produces a final text response (no more tool calls).
   *
   * Emits:
   *   "context_ready"  — after project context is gathered
   *   "stream_start"   — response streaming begins
   *   "token"          — { content }  each text chunk
   *   "stream_end"     — response streaming finished
   *   "tool_call"      — { name, args }
   *   "tool_result"    — { name, result }
   *   "response"       — { content }  final assistant text
   *   "token_usage"    — { used, max, percentage }
   *   "error"          — Error
   */
  async run(userMessage) {
    await this._init();

    // Prune conversation if approaching limit
    const usage = this.lastPromptTokens || estimateTokenCount(this.messages);
    if (usage > this.maxTokens * 0.80) {
      logger.warn(`Pruning conversation: ~${usage} tokens`);
      const keep = Math.max(6, Math.floor(this.messages.length * 0.3));
      this.messages = [this.messages[0], ...this.messages.slice(-keep)];
    }

    this.running = true;
    this.abortController = new AbortController();
    this.messages.push({ role: "user", content: userMessage });

    const tools = registry.ollamaTools(this.readOnly, this.coreToolsOnly);
    let iterations = 0;

    try {
      while (iterations++ < 200) {
        // Emit current usage for UI
        this.emit("token_usage", this.getTokenInfo());

        // ── Stream the response ──
        let fullContent = "";
        let toolCalls = [];

        this.emit("stream_start");

        for await (const event of ollama.chatStream(
          this.client, this.model, this.messages, tools,
          this.abortController.signal, this.maxTokens,
        )) {
          if (event.type === "token") {
            fullContent += event.content;
            this.emit("token", { content: event.content });
          } else if (event.type === "done") {
            toolCalls = event.toolCalls || [];
            if (event.tokenUsage) {
              this.lastPromptTokens =
                event.tokenUsage.promptTokens + event.tokenUsage.completionTokens;
            }
          }
        }

        this.emit("stream_end");

        // Fallback: parse tool calls from content text
        if (toolCalls.length === 0) {
          toolCalls = parseToolCallsFromContent(fullContent);
        }

        // Build assistant message (after fallback parsing so tool_calls are included)
        const assistantMsg = { role: "assistant", content: fullContent };
        if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
        this.messages.push(assistantMsg);

        // No tool calls → check if the model is describing work instead of doing it
        if (toolCalls.length === 0) {
          if (iterations <= 2 && looksLikeUnexecutedIntent(fullContent)) {
            // The model described what it would do instead of calling tools.
            // Nudge it to actually use tools.
            this.messages.push({
              role: "user",
              content: "Don't describe what you would do — use your tools to do it now. Call the appropriate tool.",
            });
            continue;
          }

          if (!fullContent) {
            logger.warn("Model returned empty response (no content, no tool calls)");
          }

          this.running = false;
          this.abortController = null;
          const content = fullContent || "(no response)";
          this.emit("response", { content });
          this.emit("token_usage", this.getTokenInfo());
          return content;
        }

        // ── Execute tool calls in parallel ──
        const results = await Promise.all(
          toolCalls.map(async (tc) => {
            const name = tc.function.name;
            const args = tc.function.arguments;
            this.emit("tool_call", { name, args });

            if (this.abortController.signal.aborted) {
              return { error: "Operation cancelled" };
            }

            const result = await registry.execute(name, args);
            this.emit("tool_result", { name, result });
            return result;
          }),
        );

        // Push tool results as messages
        for (const result of results) {
          this.messages.push({ role: "tool", content: JSON.stringify(result) });
        }
      }

      // Iteration limit
      this.running = false;
      this.abortController = null;
      const msg = "(Agent reached maximum iteration limit)";
      this.emit("response", { content: msg });
      return msg;
    } catch (err) {
      this.running = false;
      this.abortController = null;

      if (err.name === "AbortError" || err.message === "Operation cancelled") {
        this.emit("response", { content: "(Operation cancelled)" });
        return "(Operation cancelled)";
      }

      this.emit("error", err);
      throw err;
    }
  }

  /** Cancel the current operation. */
  cancel() {
    if (this.running && this.abortController) {
      this.abortController.abort();
    }
  }

  /** Reset conversation history and re-gather context on next run. */
  reset() {
    this.messages = [];
    this._initialized = false;
    this.lastPromptTokens = 0;
  }

  /** Get the current project context as a string. */
  async getContext() {
    return await gatherContext(this.jailDirectory, this.contextSize);
  }

  /** Get conversation messages. */
  getMessages() {
    return this.messages;
  }
}
