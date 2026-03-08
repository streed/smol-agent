/**
 * Ollama LLM provider.
 *
 * Wraps the Ollama npm client to implement the BaseLLMProvider interface.
 * This preserves all existing Ollama functionality (streaming, tool calls,
 * context calculation, model listing, web search/fetch).
 */

import { Ollama } from "ollama";
import { BaseLLMProvider, MAX_RETRIES } from "./base.js";

const DEFAULT_MODEL = process.env.SMOL_AGENT_MODEL || "qwen2.5-coder:32b";
const DEFAULT_MAX_TOKENS = 128000;
const MIN_CONTEXT = 16384;

export class OllamaProvider extends BaseLLMProvider {
  constructor({ host, model, rateLimitConfig } = {}) {
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

    this.host = host || process.env.OLLAMA_HOST || "http://127.0.0.1:11434";
    this.client = new Ollama({ host: this.host });
  }

  get name() {
    return "ollama";
  }

  /**
   * Calculate num_ctx for the Ollama request.
   * Scales with conversation size but keeps a floor and ceiling.
   */
  _calculateNumCtx(messages, maxTokens) {
    const estTokens = this.estimateTokenCount(messages);
    return Math.min(Math.max(Math.ceil(estTokens * 1.5), MIN_CONTEXT), maxTokens);
  }

  async *chatStream(messages, tools, signal, maxTokens = DEFAULT_MAX_TOKENS, onRetry) {
    const numCtx = this._calculateNumCtx(messages, maxTokens);

    const stream = await this._withRetry(() =>
      this.client.chat({
        model: this._model,
        messages,
        tools,
        stream: true,
        options: { num_ctx: numCtx },
        signal,
      }),
      MAX_RETRIES,
      onRetry,
    );

    let accumulatedToolCalls = [];

    for await (const chunk of stream) {
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

    yield { type: "done", toolCalls: accumulatedToolCalls, tokenUsage: { promptTokens: 0, completionTokens: 0 } };
  }

  async chatWithRetry(messages, tools, signal, maxTokens = DEFAULT_MAX_TOKENS, onRetry) {
    const numCtx = this._calculateNumCtx(messages, maxTokens);

    return this._withRetry(() =>
      this.client.chat({
        model: this._model,
        messages,
        tools,
        stream: false,
        options: { num_ctx: numCtx },
        signal,
      }),
      MAX_RETRIES,
      onRetry,
    );
  }

  async listModels() {
    try {
      const response = await this.client.list();
      return (response.models || []).map(m => m.name || m.model);
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
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: modelName }),
      });
      return resp.ok;
    } catch {
      return false;
    }
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

    const response = await fetch(`${this.host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: summarizationModel,
        messages,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Summarization API error: ${response.status}`);
    }

    const data = await response.json();
    return data.message?.content || "";
  }
}

export { DEFAULT_MODEL };
