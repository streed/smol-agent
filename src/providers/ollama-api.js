/**
 * Ollama API provider — talks directly to the Ollama HTTP API via fetch.
 *
 * Unlike the default OllamaProvider (which uses the `ollama` npm package),
 * this provider uses native fetch to communicate with any Ollama-compatible
 * HTTP endpoint. This is useful for:
 *   - Remote Ollama servers (no local service needed)
 *   - Ollama-compatible API proxies
 *   - Environments where the ollama npm package isn't available
 *
 * API reference: https://github.com/ollama/ollama/blob/main/docs/api.md
 *
 * Key exports:
 *   - OllamaAPIProvider class: Main provider implementation
 *
 * Dependencies: ./base.js, ./errors.js, ../constants.js
 */

import { BaseLLMProvider, MAX_RETRIES } from "./base.js";
import { formatAPIError } from "./errors.js";
import { DEFAULT_MAX_TOKENS } from "../constants.js";

const DEFAULT_MODEL = process.env.SMOL_AGENT_MODEL || "qwen2.5-coder:32b";
const MIN_CONTEXT = 16384;

export class OllamaAPIProvider extends BaseLLMProvider {
  /**
   * @param {object} options
   * @param {string} [options.host]    - Ollama API base URL (default: http://127.0.0.1:11434)
   * @param {string} [options.model]   - Model name
   * @param {string} [options.apiKey]  - Optional API key (for authenticated proxies)
   * @param {object} [options.rateLimitConfig]
   */
  constructor({ host, model, apiKey, rateLimitConfig } = {}) {
    const rpm = Math.max(1, parseInt(process.env.OLLAMA_RATE_LIMIT_PER_MINUTE) || rateLimitConfig?.requestsPerMinute || 30);
    const rps = Math.max(1, parseInt(process.env.OLLAMA_RATE_LIMIT_PER_SECOND) || rateLimitConfig?.requestsPerSecond || 1);

    super({
      model: model || DEFAULT_MODEL,
      rateLimitConfig: {
        requestsPerMinute: rpm,
        requestsPerSecond: rps,
        maxConcurrent: 1,
        rateLimitBackoffMs: 5000,
      },
    });

    this.host = (host || process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/+$/, "");
    this.apiKey = apiKey || process.env.OLLAMA_API_KEY || null;
  }

  get name() {
    return "ollama-api";
  }

  _headers() {
    const h = { "Content-Type": "application/json" };
    if (this.apiKey) {
      h["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  /**
   * Calculate num_ctx for the Ollama request.
   * Scales with conversation size but keeps a floor and ceiling.
   */
  _calculateNumCtx(messages, maxTokens) {
    const estTokens = this.estimateTokenCount(messages);
    return Math.min(Math.max(Math.ceil(estTokens * 1.5), MIN_CONTEXT), maxTokens);
  }

  /**
   * Sanitize message ordering for Ollama's API.
   *
   * Ollama requires that `tool` messages immediately follow an `assistant`
   * message containing `tool_calls`. If any `user` messages were injected
   * between the assistant's tool_calls and the tool results, move them
   * after the tool results block.
   */
  _sanitizeMessages(messages) {
    const sanitized = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === "user" && i + 1 < messages.length && messages[i + 1].role === "tool") {
        let j = i + 1;
        while (j < messages.length && messages[j].role === "tool") j++;
        for (let k = i + 1; k < j; k++) {
          sanitized.push(messages[k]);
        }
        sanitized.push(msg);
        i = j - 1;
        continue;
      }

      sanitized.push(msg);
    }
    return sanitized;
  }

  async *chatStream(messages, tools, signal, maxTokens = DEFAULT_MAX_TOKENS, onRetry) {
    const sanitized = this._sanitizeMessages(messages);
    const numCtx = this._calculateNumCtx(sanitized, maxTokens);

    const body = {
      model: this._model,
      messages: sanitized,
      stream: true,
      options: { num_ctx: numCtx },
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    const response = await this._withRetry(async () => {
      const resp = await fetch(`${this.host}/api/chat`, {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify(body),
        signal,
      });
      if (!resp.ok) {
        let errorBody = "";
        try { errorBody = await resp.text(); } catch { /* ignore */ }
        const { message, actionable } = formatAPIError(resp.status, errorBody, "Ollama API", "OLLAMA_API_KEY");
        const err = new Error(actionable ? `${message}\n  → ${actionable}` : message);
        err.status = resp.status;
        err.body = errorBody;
        throw err;
      }
      return resp;
    }, MAX_RETRIES, onRetry);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const accumulatedToolCalls = [];

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let chunk;
          try { chunk = JSON.parse(trimmed); } catch { continue; }

          if (chunk.message?.content) {
            yield { type: "token", content: chunk.message.content };
          }

          if (chunk.message?.tool_calls?.length) {
            accumulatedToolCalls.push(...chunk.message.tool_calls);
          }

          if (chunk.done) {
            yield {
              type: "done",
              toolCalls: accumulatedToolCalls,
              tokenUsage: {
                promptTokens: chunk.prompt_eval_count || 0,
                completionTokens: chunk.eval_count || 0,
              },
            };
            return;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield { type: "done", toolCalls: accumulatedToolCalls, tokenUsage: { promptTokens: 0, completionTokens: 0 } };
  }

  async chatWithRetry(messages, tools, signal, maxTokens = DEFAULT_MAX_TOKENS, onRetry) {
    const sanitized = this._sanitizeMessages(messages);
    const numCtx = this._calculateNumCtx(sanitized, maxTokens);

    const body = {
      model: this._model,
      messages: sanitized,
      stream: false,
      options: { num_ctx: numCtx },
    };
    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    const data = await this._withRetry(async () => {
      const resp = await fetch(`${this.host}/api/chat`, {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify(body),
        signal,
      });
      if (!resp.ok) {
        let errorBody = "";
        try { errorBody = await resp.text(); } catch { /* ignore */ }
        const { message, actionable } = formatAPIError(resp.status, errorBody, "Ollama API", "OLLAMA_API_KEY");
        const err = new Error(actionable ? `${message}\n  → ${actionable}` : message);
        err.status = resp.status;
        err.body = errorBody;
        throw err;
      }
      return resp.json();
    }, MAX_RETRIES, onRetry);

    return {
      message: {
        content: data.message?.content || "",
        tool_calls: data.message?.tool_calls || [],
      },
    };
  }

  async listModels() {
    try {
      const resp = await fetch(`${this.host}/api/tags`, {
        headers: this._headers(),
      });
      if (!resp.ok) return [];
      const data = await resp.json();
      return (data.models || []).map(m => m.name || m.model);
    } catch {
      return [];
    }
  }

  /**
   * Check if a specific model is available on this Ollama host.
   */
  async hasModel(modelName) {
    try {
      const resp = await fetch(`${this.host}/api/show`, {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify({ name: modelName }),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /**
   * Check if this model supports vision (image inputs).
   */
  supportsVision() {
    const model = this._model.toLowerCase();
    const visionModels = ['llava', 'bakllava', 'moondream', 'pixtral', 'gemma3', 'minicpm-v', 'xgen', 'llava-next', 'llava-v1.6', 'vila'];
    return visionModels.some(vm => model.includes(vm));
  }

  /**
   * Summarize using a smaller model variant if available.
   */
  async summarize(messages) {
    let summarizationModel = this._model;
    if (this._model.includes("32b") || this._model.includes("70b") || this._model.includes("72b")) {
      const candidate = this._model.replace(/32b|70b|72b/, "7b");
      if (await this.hasModel(candidate)) {
        summarizationModel = candidate;
      }
    }

    const resp = await fetch(`${this.host}/api/chat`, {
      method: "POST",
      headers: this._headers(),
      body: JSON.stringify({
        model: summarizationModel,
        messages,
        stream: false,
      }),
    });

    if (!resp.ok) {
      throw new Error(`Summarization API error: ${resp.status}`);
    }

    const data = await resp.json();
    return data.message?.content || "";
  }
}

export { DEFAULT_MODEL };
