/**
 * OpenAI-compatible LLM provider.
 *
 * Works with any OpenAI-compatible API:
 *   - OpenAI (ChatGPT): https://api.openai.com/v1
 *   - Grok (xAI):       https://api.x.ai/v1
 *   - Together AI:      https://api.together.xyz/v1
 *   - OpenRouter:       https://openrouter.ai/api/v1
 *   - Local (vLLM, LM Studio, etc.)
 *
 * Uses the standard OpenAI chat completions API with tool calling support.
 * No SDK dependency — uses native fetch for maximum compatibility.
 */

import { BaseLLMProvider, MAX_RETRIES } from "./base.js";

const DEFAULT_MAX_TOKENS = 128000;

export class OpenAICompatibleProvider extends BaseLLMProvider {
  /**
   * @param {object} options
   * @param {string} options.apiKey     - API key (or set via env)
   * @param {string} options.baseURL    - API base URL
   * @param {string} options.model      - Model name (e.g. "gpt-4o", "grok-3")
   * @param {string} [options.providerName] - Display name for this provider
   * @param {object} [options.rateLimitConfig]
   */
  constructor({ apiKey, baseURL, model, providerName, rateLimitConfig } = {}) {
    super({
      model,
      rateLimitConfig: rateLimitConfig || {
        requestsPerMinute: 60,
        requestsPerSecond: 5,
        maxConcurrent: 1,
        rateLimitBackoffMs: 5000,
      },
    });

    this.apiKey = apiKey;
    this.baseURL = (baseURL || "https://api.openai.com/v1").replace(/\/+$/, "");
    this._providerName = providerName || "openai";
  }

  get name() {
    return this._providerName;
  }

  _headers() {
    const h = { "Content-Type": "application/json" };
    if (this.apiKey) {
      h["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  /**
   * Convert tool calls from the OpenAI response format to our normalized format.
   */
  _normalizeToolCalls(toolCalls) {
    if (!toolCalls || toolCalls.length === 0) return [];
    return toolCalls.map(tc => ({
      function: {
        name: tc.function.name,
        arguments: typeof tc.function.arguments === "string"
          ? JSON.parse(tc.function.arguments)
          : tc.function.arguments,
      },
    }));
  }

  async *chatStream(messages, tools, signal, maxTokens = DEFAULT_MAX_TOKENS, onRetry) {
    const body = {
      model: this._model,
      messages,
      stream: true,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    const response = await this._withRetry(async () => {
      const resp = await fetch(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify(body),
        signal,
      });
      if (!resp.ok) {
        const err = new Error(`API error: ${resp.status}`);
        err.status = resp.status;
        try { err.body = await resp.text(); } catch {}
        throw err;
      }
      return resp;
    }, MAX_RETRIES, onRetry);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const toolCallsById = new Map();
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
          if (!trimmed || trimmed === "data: [DONE]") continue;
          if (!trimmed.startsWith("data: ")) continue;

          let data;
          try { data = JSON.parse(trimmed.slice(6)); } catch { continue; }

          const choice = data.choices?.[0];
          if (!choice) continue;

          const delta = choice.delta;
          if (delta?.content) {
            yield { type: "token", content: delta.content };
          }

          // Accumulate streamed tool calls
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const id = tc.index ?? tc.id ?? 0;
              if (!toolCallsById.has(id)) {
                toolCallsById.set(id, { function: { name: "", arguments: "" } });
              }
              const existing = toolCallsById.get(id);
              if (tc.function?.name) existing.function.name = tc.function.name;
              if (tc.function?.arguments) existing.function.arguments += tc.function.arguments;
            }
          }

          // Capture usage from the final chunk
          if (data.usage) {
            promptTokens = data.usage.prompt_tokens || 0;
            completionTokens = data.usage.completion_tokens || 0;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Parse accumulated tool call arguments
    const toolCalls = [...toolCallsById.values()].map(tc => {
      let args = tc.function.arguments;
      try { args = JSON.parse(args); } catch {}
      return { function: { name: tc.function.name, arguments: args } };
    });

    yield {
      type: "done",
      toolCalls,
      tokenUsage: { promptTokens, completionTokens },
    };
  }

  async chatWithRetry(messages, tools, signal, maxTokens = DEFAULT_MAX_TOKENS, onRetry) {
    const body = {
      model: this._model,
      messages,
      stream: false,
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    const data = await this._withRetry(async () => {
      const resp = await fetch(`${this.baseURL}/chat/completions`, {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify(body),
        signal,
      });
      if (!resp.ok) {
        const err = new Error(`API error: ${resp.status}`);
        err.status = resp.status;
        try { err.body = await resp.text(); } catch {}
        throw err;
      }
      return resp.json();
    }, MAX_RETRIES, onRetry);

    const choice = data.choices?.[0];
    return {
      message: {
        content: choice?.message?.content || "",
        tool_calls: this._normalizeToolCalls(choice?.message?.tool_calls),
      },
    };
  }

  async listModels() {
    try {
      const resp = await fetch(`${this.baseURL}/models`, {
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
