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

const DEFAULT_MAX_TOKENS = 8192; // Anthropic max output tokens

export class AnthropicProvider extends BaseLLMProvider {
  /**
   * @param {object} options
   * @param {string} options.apiKey - Anthropic API key
   * @param {string} options.model  - Model name (e.g. "claude-sonnet-4-20250514")
   * @param {string} [options.baseURL] - API base URL (for proxies)
   * @param {object} [options.rateLimitConfig]
   */
  constructor({ apiKey, model, baseURL, rateLimitConfig } = {}) {
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
   * Convert generic tool format (Ollama/OpenAI style) to Anthropic's format.
   */
  formatTools(tools) {
    if (!tools || tools.length === 0) return [];
    return tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters || { type: "object", properties: {} },
    }));
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

      if (msg.role === "assistant" && msg.tool_calls?.length) {
        // Convert assistant tool calls to Anthropic's tool_use content blocks.
        // Generate stable IDs and record them so tool result messages can use them.
        pendingToolUseIds = [];
        const content = [];
        if (msg.content) {
          content.push({ type: "text", text: msg.content });
        }
        for (let i = 0; i < msg.tool_calls.length; i++) {
          const tc = msg.tool_calls[i];
          const id = tc.id || `tool_use_${converted.length}_${i}`;
          pendingToolUseIds.push(id);
          content.push({
            type: "tool_use",
            id,
            name: tc.function.name,
            input: tc.function.arguments,
          });
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
   */
  _parseResponseContent(content) {
    if (!Array.isArray(content)) {
      return { text: content || "", toolCalls: [] };
    }

    let text = "";
    const toolCalls = [];

    for (const block of content) {
      if (block.type === "text") {
        text += block.text;
      } else if (block.type === "tool_use") {
        toolCalls.push({
          id: block.id,
          function: {
            name: block.name,
            arguments: block.input,
          },
        });
      }
    }

    return { text, toolCalls };
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

    const response = await this._withRetry(async () => {
      const resp = await fetch(`${this.baseURL}/v1/messages`, {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify(body),
        signal,
      });
      if (!resp.ok) {
        const err = new Error(`Anthropic API error: ${resp.status}`);
        err.status = resp.status;
        try { err.body = await resp.text(); } catch { /* ignore */ }
        throw err;
      }
      return resp;
    }, MAX_RETRIES, onRetry);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const toolCalls = [];
    let currentToolUse = null;
    let currentToolInput = "";
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
                currentToolUse = {
                  id: data.content_block.id,
                  function: { name: data.content_block.name, arguments: {} },
                };
                currentToolInput = "";
              }
              break;

            case "content_block_delta":
              if (data.delta?.type === "text_delta" && data.delta.text) {
                yield { type: "token", content: data.delta.text };
              }
              if (data.delta?.type === "input_json_delta" && data.delta.partial_json) {
                currentToolInput += data.delta.partial_json;
              }
              break;

            case "content_block_stop":
              if (currentToolUse) {
                try {
                  currentToolUse.function.arguments = JSON.parse(currentToolInput || "{}");
                } catch {
                  currentToolUse.function.arguments = {};
                }
                toolCalls.push(currentToolUse);
                currentToolUse = null;
                currentToolInput = "";
              }
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

    const data = await this._withRetry(async () => {
      const resp = await fetch(`${this.baseURL}/v1/messages`, {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify(body),
        signal,
      });
      if (!resp.ok) {
        const err = new Error(`Anthropic API error: ${resp.status}`);
        err.status = resp.status;
        try { err.body = await resp.text(); } catch { /* ignore */ }
        throw err;
      }
      return resp.json();
    }, MAX_RETRIES, onRetry);

    const { text, toolCalls } = this._parseResponseContent(data.content);

    return {
      message: {
        content: text,
        tool_calls: toolCalls,
      },
    };
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
