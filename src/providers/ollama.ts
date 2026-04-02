/**
 * Ollama LLM provider.
 *
 * Wraps the Ollama npm client to implement the BaseLLMProvider interface.
 * This preserves all existing Ollama functionality (streaming, tool calls,
 * context calculation, model listing, web search/fetch).
 *
 * Key exports:
 *   - OllamaProvider class: Main provider implementation
 *   - DEFAULT_MODEL: Default model (qwen2.5-coder:32b or SMOL_AGENT_MODEL env)
 *   - Methods: chatStream(), chatWithRetry(), listModels(), formatTools()
 *
 * Dependencies: ollama (npm), ./base.js, ../constants.js
 * Depended on by: src/agent.js, src/architect.js, src/context-manager.js,
 *                 src/context-summarizer.js, src/errors.js, src/index.js,
 *                 src/ollama.js, src/providers/index.js, src/providers/openai-compatible.js,
 *                 src/tools/registry.js, src/ui/App.js, test/e2e/llm-judge.js,
 *                 test/e2e/runner.js, test/unit/errors.test.js, test/unit/providers.test.js,
 *                 test/unit/registry.test.js, test/unit/vision-support.test.js
 */

import { Ollama } from "ollama";
import { BaseLLMProvider, MAX_RETRIES, type ChatMessage, type ToolDefinition, type StreamEvent, type OnRetryCallback, type ChatResponse } from "./base.js";
import { DEFAULT_MAX_TOKENS } from "../constants.js";

const DEFAULT_MODEL = process.env.SMOL_AGENT_MODEL || "qwen2.5-coder:32b";
const MIN_CONTEXT = 16384;

export { DEFAULT_MODEL };

export class OllamaProvider extends BaseLLMProvider {
  host: string;
  client: Ollama;

  constructor({ host, model, rateLimitConfig }: { host?: string; model?: string; rateLimitConfig?: Partial<import("./base.js").RateLimitConfig> } = {}) {
    const rpm = Math.max(1, parseInt(process.env.OLLAMA_RATE_LIMIT_PER_MINUTE || "") || rateLimitConfig?.requestsPerMinute || 30);
    const rps = Math.max(1, parseInt(process.env.OLLAMA_RATE_LIMIT_PER_SECOND || "") || rateLimitConfig?.requestsPerSecond || 1);

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

  get name(): string {
    return "ollama";
  }

  /**
   * Calculate num_ctx for the Ollama request.
   * Scales with conversation size but keeps a floor and ceiling.
   */
  protected _calculateNumCtx(messages: ChatMessage[], maxTokens: number): number {
    const estTokens = this.estimateTokenCount(messages);
    return Math.min(Math.max(Math.ceil(estTokens * 1.5), MIN_CONTEXT), maxTokens);
  }

  /**
   * Sanitize message ordering for Ollama's API.
   *
   * Ollama requires that `tool` messages immediately follow an `assistant`
   * message containing `tool_calls`. If any `user` messages were injected
   * between the assistant's tool_calls and the tool results (e.g. loop
   * warnings or hints), move them after the tool results block.
   */
  protected _sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
    const sanitized: ChatMessage[] = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      // If this is a user message and the next message is a tool message,
      // defer this user message until after the tool result block
      if (msg.role === "user" && i + 1 < messages.length && messages[i + 1].role === "tool") {
        // Find the end of the tool result block
        let j = i + 1;
        while (j < messages.length && messages[j].role === "tool") j++;
        // Push tool results first, then the deferred user message
        for (let k = i + 1; k < j; k++) {
          sanitized.push(messages[k]);
        }
        sanitized.push(msg);
        i = j - 1; // skip past the tool results (loop will i++)
        continue;
      }

      sanitized.push(msg);
    }
    return sanitized;
  }

  async *chatStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
    maxTokens: number = DEFAULT_MAX_TOKENS,
    onRetry?: OnRetryCallback
  ): AsyncGenerator<StreamEvent> {
    const sanitized = this._sanitizeMessages(messages);
    const numCtx = this._calculateNumCtx(sanitized, maxTokens);

    const stream = await this._withRetry(
      async () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const result = await (this.client.chat as any)({
          model: this._model,
          messages: sanitized,
          tools,
          stream: true,
          options: { num_ctx: numCtx },
          signal,
        });
        return result;
      },
      MAX_RETRIES,
      onRetry,
    );

    const accumulatedToolCalls: Array<{ function: { name: string; arguments: string | Record<string, unknown> } }> = [];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for await (const chunk of stream as any) {
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

  async chatWithRetry(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
    maxTokens: number = DEFAULT_MAX_TOKENS,
    onRetry?: OnRetryCallback
  ): Promise<ChatResponse> {
    const sanitized = this._sanitizeMessages(messages);
    const numCtx = this._calculateNumCtx(sanitized, maxTokens);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const response = (await this._withRetry(
      async () => {
        const result = await (this.client.chat as any)({
          model: this._model,
          messages: sanitized,
          tools,
          stream: false,
          options: { num_ctx: numCtx },
          signal,
        });
        return result;
      },
      MAX_RETRIES,
      onRetry,
    )) as any;

    return {
      message: {
        content: response.message?.content,
        tool_calls: response.message?.tool_calls,
      },
    };
  }

  async listModels(): Promise<string[]> {
    try {
      const response = await this.client.list();
      return (response.models || []).map(m => m.name || m.model);
    } catch {
      return [];
    }
  }

  /**
   * Check if this model supports vision (image inputs).
   * Vision-capable Ollama models include: llava, bakllava, moondream, pixtral, gemma3
   */
  supportsVision(): boolean {
    const model = this._model.toLowerCase();
    const visionModels = ['llava', 'bakllava', 'moondream', 'pixtral', 'gemma3', 'minicpm-v', 'xgen', 'llava-next', 'llava-v1.6', 'vila'];
    return visionModels.some(vm => model.includes(vm));
  }

  /**
   * Check if a specific model is available on this Ollama host.
   */
  async hasModel(modelName: string): Promise<boolean> {
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
  async summarize(messages: ChatMessage[]): Promise<string> {
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

    const data = await response.json() as { message?: { content?: string } };
    return data.message?.content || "";
  }
}