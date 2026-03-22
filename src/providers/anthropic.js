/**
 * Anthropic (Claude) LLM provider.
 *
 * Uses the Anthropic Messages API with tool use support.
 * No SDK dependency — uses native fetch.
 *
 * API docs: https://docs.anthropic.com/en/docs/build-with-claude/tool-use
 *
 * Key differences from OpenAI format:
 *   - System prompt is a top-level parameter, not a message
 *   - Tool definitions use input_schema instead of parameters
 *   - Tool results use tool_result content blocks
 *   - Streaming uses server-sent events with different event types
 */

import { BaseLLMProvider, MAX_RETRIES } from "./base.js";
import { formatAPIError } from "./errors.js";

const DEFAULT_MAX_TOKENS = 8192; // Anthropic max output tokens

export class AnthropicProvider extends BaseLLMProvider {
  /**
   * @param {object} options
   * @param {string} options.apiKey - Anthropic API key
   * @param {string} options.model  - Model name (e.g. "claude-sonnet-4-20250514")
   * @param {string} [options.baseURL] - API base URL (for proxies)
   * @param {object} [options.rateLimitConfig]
   */
  /**
   * @param {object} options
   * @param {string} options.apiKey - Anthropic API key
   * @param {string} options.model  - Model name (e.g. "claude-sonnet-4-20250514")
   * @param {string} [options.baseURL] - API base URL (for proxies)
   * @param {object} [options.rateLimitConfig]
   * @param {boolean} [options.programmaticToolCalling] - Enable server-side programmatic tool calling
   */
  constructor({ apiKey, model, baseURL, rateLimitConfig, programmaticToolCalling } = {}) {
    super({
      model: model || "claude-sonnet-4-20250514",
      rateLimitConfig: rateLimitConfig || {
        requestsPerMinute: 50,
        requestsPerSecond: 5,
        maxConcurrent: 1,
        rateLimitBackoffMs: 5000,
      },
    });

    this.apiKey = apiKey;
    this.baseURL = (baseURL || "https://api.anthropic.com").replace(/\/+$/, "");

    // Server-side programmatic tool calling (Anthropic-native code execution)
    this.programmaticToolCalling = programmaticToolCalling ?? false;
    // Container ID for reusing code execution sandboxes across turns
    this._containerId = null;

    if (!this.apiKey) {
      console.error("⚠️  No ANTHROPIC_API_KEY found. Set it via:");
      console.error("   export ANTHROPIC_API_KEY=your-key-here");
      console.error("   or use --api-key option");
    }
  }

  get name() {
    return "anthropic";
  }

  _headers() {
    const headers = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }
    return headers;
  }

  /**
   * Format a user-friendly error message based on HTTP status code.
   */
  _formatError(status, body = "") {
    const { message, actionable } = formatAPIError(status, body, "Anthropic", "ANTHROPIC_API_KEY");
    return actionable ? `${message}\n  → ${actionable}` : message;
  }

  /** Models that support Anthropic's server-side programmatic tool calling. */
  static PROGRAMMATIC_MODELS = new Set([
    "claude-opus-4-6", "claude-sonnet-4-6",
    "claude-sonnet-4-5-20250929", "claude-opus-4-5-20251101",
  ]);

  /** Check if the current model supports server-side programmatic tool calling. */
  supportsProgrammaticToolCalling() {
    return AnthropicProvider.PROGRAMMATIC_MODELS.has(this._model);
  }

  /**
   * Convert generic tool format (Ollama/OpenAI style) to Anthropic's format.
   * When programmatic tool calling is enabled and the model supports it,
   * injects the code_execution tool and sets allowed_callers on other tools.
   */
  formatTools(tools) {
    if (!tools || tools.length === 0) return [];

    const useProgrammatic = this.programmaticToolCalling && this.supportsProgrammaticToolCalling();

    const formatted = tools
      // Skip client-side code_execution when using server-side programmatic calling
      .filter(t => !(useProgrammatic && t.function.name === "code_execution"))
      .map(t => {
        const tool = {
          name: t.function.name,
          description: t.function.description,
          input_schema: t.function.parameters || { type: "object", properties: {} },
        };
        // When programmatic calling is enabled, mark tools as callable from code execution
        if (useProgrammatic) {
          tool.allowed_callers = ["code_execution_20260120"];
        }
        return tool;
      });

    // Prepend the Anthropic code execution tool
    if (useProgrammatic) {
      formatted.unshift({
        type: "code_execution_20260120",
        name: "code_execution",
      });
    }

    return formatted;
  }

  /**
   * Convert messages from the generic format to Anthropic's format.
   * Extracts the system message and converts tool messages to tool_result blocks.
   *
   * Tool result messages must include `tool_use_id` matching the prior assistant
   * `tool_use` block IDs. We derive those IDs by looking at the most recent
   * assistant message's tool_calls and correlating in order.
   */
  _convertMessages(messages) {
    let system = "";
    const converted = [];

    // Track pending tool_use IDs from the most recent assistant message so we
    // can assign them in order to subsequent tool result messages.
    let pendingToolUseIds = [];


    for (const msg of messages) {
      if (msg.role === "system") {
        system += (system ? "\n\n" : "") + msg.content;
        continue;
      }

      if (msg.role === "tool") {
        // Derive tool_use_id: prefer explicit field, then take from pending queue
        const toolUseId = msg.tool_use_id
          || (pendingToolUseIds.length > 0 ? pendingToolUseIds.shift() : null)
          || `tool_result_${converted.length}`;

        // Anthropic expects tool results as user messages with tool_result content
        converted.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: toolUseId,
            content: msg.content,
          }],
        });
        continue;
      }

      if (msg.role === "assistant" && (msg.tool_calls?.length || msg._serverToolUses?.length)) {
        // Convert assistant tool calls to Anthropic's tool_use content blocks.
        // Generate stable IDs and record them so tool result messages can use them.
        pendingToolUseIds = [];
        const content = [];
        if (msg.content) {
          content.push({ type: "text", text: msg.content });
        }
        // Re-emit server_tool_use blocks (from programmatic tool calling)
        if (msg._serverToolUses) {
          for (const stu of msg._serverToolUses) {
            content.push({
              type: "server_tool_use",
              id: stu.id,
              name: stu.name,
              input: stu.input,
            });
          }
        }
        for (let i = 0; i < (msg.tool_calls || []).length; i++) {
          const tc = msg.tool_calls[i];
          const id = tc.id || `tool_use_${converted.length}_${i}`;
          pendingToolUseIds.push(id);
          const block = {
            type: "tool_use",
            id,
            name: tc.function.name,
            input: tc.function.arguments,
          };
          // Preserve caller metadata for programmatic tool calls
          if (tc.caller) {
            block.caller = tc.caller;
          }
          content.push(block);
        }
        // Include code_execution_tool_result blocks if present
        if (msg._codeExecutionResults) {
          for (const cer of msg._codeExecutionResults) {
            content.push(cer);
          }
        }
        converted.push({ role: "assistant", content });
        continue;
      }

      // Non-tool-call assistant or user messages reset the pending queue
      if (msg.role === "assistant") {
        pendingToolUseIds = [];
      }


      // Regular user/assistant messages
      converted.push({
        role: msg.role,
        content: msg.content || "",
      });
    }

    // Anthropic requires alternating user/assistant messages.
    // Merge consecutive same-role messages.
    const merged = [];
    for (const msg of converted) {
      if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
        const prev = merged[merged.length - 1];
        if (typeof prev.content === "string" && typeof msg.content === "string") {
          prev.content += "\n\n" + msg.content;
        } else {
          // Convert to array form and append
          const prevContent = typeof prev.content === "string"
            ? [{ type: "text", text: prev.content }]
            : prev.content;
          const newContent = typeof msg.content === "string"
            ? [{ type: "text", text: msg.content }]
            : msg.content;
          prev.content = [...prevContent, ...newContent];
        }
      } else {
        merged.push({ ...msg });
      }
    }

    return { system, messages: merged };
  }

  /**
   * Extract tool calls and content from Anthropic response content blocks.
   * Also extracts server_tool_use and code_execution_tool_result blocks
   * for programmatic tool calling support.
   */
  _parseResponseContent(content) {
    if (!Array.isArray(content)) {
      return { text: content || "", toolCalls: [], serverToolUses: [], codeExecutionResults: [] };
    }

    let text = "";
    const toolCalls = [];
    const serverToolUses = [];
    const codeExecutionResults = [];

    for (const block of content) {
      if (block.type === "text") {
        text += block.text;
      } else if (block.type === "tool_use") {
        const tc = {
          id: block.id,
          function: {
            name: block.name,
            arguments: block.input,
          },
        };
        if (block.caller) {
          tc.caller = block.caller;
        }
        toolCalls.push(tc);
      } else if (block.type === "server_tool_use") {
        serverToolUses.push({
          id: block.id,
          name: block.name,
          input: block.input,
        });
      } else if (block.type === "code_execution_tool_result") {
        codeExecutionResults.push(block);
        // Extract stdout as text for the model to see
        if (block.content?.stdout) {
          text += `\n[Code execution output]\n${block.content.stdout}`;
        }
        if (block.content?.stderr) {
          text += `\n[Code execution stderr]\n${block.content.stderr}`;
        }
      }
    }

    return { text, toolCalls, serverToolUses, codeExecutionResults };
  }

  async *chatStream(messages, tools, signal, maxTokens = DEFAULT_MAX_TOKENS, onRetry) {
    const { system, messages: convertedMessages } = this._convertMessages(messages);
    const anthropicTools = this.formatTools(tools);

    const body = {
      model: this._model,
      max_tokens: maxTokens > 8192 ? 8192 : maxTokens, // Anthropic's output token limit
      messages: convertedMessages,
      stream: true,
    };
    if (system) body.system = system;
    if (anthropicTools.length > 0) body.tools = anthropicTools;
    // Reuse code execution container if available
    if (this._containerId) body.container = this._containerId;

    const response = await this._withRetry(async () => {
      const resp = await fetch(`${this.baseURL}/v1/messages`, {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify(body),
        signal,
      });
      if (!resp.ok) {
        let errorBody = "";
        try { errorBody = await resp.text(); } catch { /* ignore */ }
        const err = new Error(this._formatError(resp.status, errorBody));
        err.status = resp.status;
        err.body = errorBody;
        throw err;
      }
      return resp;
    }, MAX_RETRIES, onRetry);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const toolCalls = [];
    const serverToolUses = [];
    const codeExecutionResults = [];
    let currentToolUse = null;
    let currentToolInput = "";
    let currentServerToolUse = null;
    let currentServerToolInput = "";
    let currentBlockType = null;
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;

          let data;
          try { data = JSON.parse(trimmed.slice(6)); } catch { continue; }

          switch (data.type) {
            case "content_block_start":
              if (data.content_block?.type === "tool_use") {
                currentBlockType = "tool_use";
                currentToolUse = {
                  id: data.content_block.id,
                  function: { name: data.content_block.name, arguments: {} },
                };
                // Preserve caller metadata for programmatic tool calls
                if (data.content_block.caller) {
                  currentToolUse.caller = data.content_block.caller;
                }
                currentToolInput = "";
              } else if (data.content_block?.type === "server_tool_use") {
                currentBlockType = "server_tool_use";
                currentServerToolUse = {
                  id: data.content_block.id,
                  name: data.content_block.name,
                  input: {},
                };
                currentServerToolInput = "";
              } else if (data.content_block?.type === "code_execution_tool_result") {
                currentBlockType = "code_execution_tool_result";
                // Will be populated from content_block_stop or delta
                codeExecutionResults.push(data.content_block);
              } else {
                currentBlockType = data.content_block?.type || null;
              }
              break;

            case "content_block_delta":
              if (data.delta?.type === "text_delta" && data.delta.text) {
                yield { type: "token", content: data.delta.text };
              }
              if (data.delta?.type === "input_json_delta" && data.delta.partial_json) {
                if (currentBlockType === "server_tool_use") {
                  currentServerToolInput += data.delta.partial_json;
                } else {
                  currentToolInput += data.delta.partial_json;
                }
              }
              break;

            case "content_block_stop":
              if (currentBlockType === "tool_use" && currentToolUse) {
                try {
                  currentToolUse.function.arguments = JSON.parse(currentToolInput || "{}");
                } catch {
                  currentToolUse.function.arguments = {};
                }
                toolCalls.push(currentToolUse);
                currentToolUse = null;
                currentToolInput = "";
              } else if (currentBlockType === "server_tool_use" && currentServerToolUse) {
                try {
                  currentServerToolUse.input = JSON.parse(currentServerToolInput || "{}");
                } catch {
                  currentServerToolUse.input = {};
                }
                serverToolUses.push(currentServerToolUse);
                currentServerToolUse = null;
                currentServerToolInput = "";
              }
              currentBlockType = null;
              break;

            case "message_delta":
              // Usage info comes here
              if (data.usage) {
                completionTokens = data.usage.output_tokens || 0;
              }
              break;

            case "message_start":
              if (data.message?.usage) {
                promptTokens = data.message.usage.input_tokens || 0;
              }
              // Track container ID for reuse
              if (data.message?.container?.id) {
                this._containerId = data.message.container.id;
              }
              break;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield {
      type: "done",
      toolCalls,
      serverToolUses,
      codeExecutionResults,
      tokenUsage: { promptTokens, completionTokens },
    };
  }

  async chatWithRetry(messages, tools, signal, maxTokens = DEFAULT_MAX_TOKENS, onRetry) {
    const { system, messages: convertedMessages } = this._convertMessages(messages);
    const anthropicTools = this.formatTools(tools);

    const body = {
      model: this._model,
      max_tokens: maxTokens > 8192 ? 8192 : maxTokens,
      messages: convertedMessages,
    };
    if (system) body.system = system;
    if (anthropicTools.length > 0) body.tools = anthropicTools;
    if (this._containerId) body.container = this._containerId;

    const respData = await this._withRetry(async () => {
      const resp = await fetch(`${this.baseURL}/v1/messages`, {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify(body),
        signal,
      });
      if (!resp.ok) {
        let errorBody = "";
        try { errorBody = await resp.text(); } catch { /* ignore */ }
        const err = new Error(this._formatError(resp.status, errorBody));
        err.status = resp.status;
        err.body = errorBody;
        throw err;
      }
      return resp.json();
    }, MAX_RETRIES, onRetry);

    // Track container ID for reuse
    if (respData.container?.id) {
      this._containerId = respData.container.id;
    }

    const { text, toolCalls, serverToolUses, codeExecutionResults } =
      this._parseResponseContent(respData.content);

    const message = {
      content: text,
      tool_calls: toolCalls,
    };
    if (serverToolUses.length > 0) message._serverToolUses = serverToolUses;
    if (codeExecutionResults.length > 0) message._codeExecutionResults = codeExecutionResults;

    return { message };
  }

  async listModels() {
    try {
      const resp = await fetch(`${this.baseURL}/v1/models`, {
        headers: this._headers(),
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.data || []).map(m => m.id);
    } catch {
      return [];
    }
  }
}
