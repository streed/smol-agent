/**
 * OpenAI-compatible LLM provider.
 *
 * Works with any OpenAI-compatible API:
 *   - OpenAI (ChatGPT): https://api.openai.com/v1
 *   - Grok (xAI):       https://api.x.ai/v1
 *   - Groq:             https://api.groq.com/openai/v1
 *   - Gemini (Google):  https://generativelanguage.googleapis.com/v1beta/openai
 *   - Together AI:      https://api.together.xyz/v1
 *   - OpenRouter:       https://openrouter.ai/api/v1
 *   - Local (vLLM, LM Studio, etc.)
 *
 * Uses the standard OpenAI chat completions API with tool calling support.
 * No SDK dependency — uses native fetch for maximum compatibility.
 *
 * Key exports:
 *   - OpenAICompatibleProvider class: Main provider implementation
 *   - Methods: chatStream(), chatWithRetry(), listModels(), formatTools()
 *
 * Dependencies: ./base.js, ./errors.js, ../constants.js
 * Depended on by: src/providers/index.js, test/unit/providers.test.js,
 *                  test/unit/vision-support.test.js
 */

import { BaseLLMProvider, MAX_RETRIES, type ChatMessage, type ToolDefinition, type StreamEvent, type OnRetryCallback, type ChatResponse } from "./base.js";
import { formatAPIError } from "./errors.js";
import { DEFAULT_MAX_TOKENS } from "../constants.js";

interface OpenAIToolCall {
  id?: string;
  type?: "function";
  function: {
    name: string;
    arguments: string | Record<string, unknown>;
  };
}

interface AdaptedMessage {
  role: string;
  content?: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export class OpenAICompatibleProvider extends BaseLLMProvider {
  apiKey: string | null;
  baseURL: string;
  _providerName: string;

  constructor({ apiKey, baseURL, model, providerName, rateLimitConfig }: {
    apiKey?: string;
    baseURL?: string;
    model?: string;
    providerName?: string;
    rateLimitConfig?: Partial<import("./base.js").RateLimitConfig>;
  } = {}) {
    super({
      model,
      rateLimitConfig: rateLimitConfig || {
        requestsPerMinute: 60,
        requestsPerSecond: 5,
        maxConcurrent: 1,
        rateLimitBackoffMs: 5000,
      },
    });

    this.apiKey = apiKey || null;
    this.baseURL = (baseURL || "https://api.openai.com/v1").replace(/\/+$/, "");
    this._providerName = providerName || "openai";

    // Special handling for Gemini's OpenAI-compatible endpoint
    if (this._providerName === "gemini") {
      this.baseURL = (baseURL || "https://generativelanguage.googleapis.com/v1beta/models").replace(/\/+$/, "");
    }

    // Warn if API key is missing for providers that require it
    if (!this.apiKey && this._providerName !== "ollama") {
      const envVar = this._envVar();
      console.error(`⚠️  No ${envVar} found. Set it via:`);
      console.error(`   export ${envVar}=your-key-here`);
      console.error(`   or use --api-key option`);
    }
  }

  get name(): string {
    return this._providerName;
  }

  /**
   * Get the environment variable name for this provider's API key.
   */
  _envVar(): string {
    switch (this._providerName) {
      case "openai":
        return "OPENAI_API_KEY";
      case "anthropic":
        return "ANTHROPIC_API_KEY";
      case "grok":
        return "XAI_API_KEY";
      case "groq":
        return "GROQ_API_KEY";
      case "gemini":
        return "GEMINI_API_KEY";
      default:
        return `${this._providerName.toUpperCase()}_API_KEY`;
    }
  }

  _headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) {
      h["Authorization"] = `Bearer ${this.apiKey}`;
    }
    return h;
  }

  /**
   * Convert tool calls from the OpenAI response format to our normalized format.
   */
  _normalizeToolCalls(toolCalls?: Array<{ id?: string; function: { name: string; arguments: string | Record<string, unknown> } }>): OpenAIToolCall[] {
    if (!toolCalls || toolCalls.length === 0) return [];
    return toolCalls.map(tc => {
      let args = tc.function.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch (e) {
          const err = e as Error;
          console.warn(
            `[${this._providerName}] Failed to parse tool call arguments as JSON:`,
            err.message,
            "Raw arguments:",
            tc.function.arguments
          );
          args = {};
        }
      }
      return {
        id: tc.id,
        function: {
          name: tc.function.name,
          arguments: args,
        },
      };
    });
  }

  /**
   * Adapt internal agent messages to OpenAI-compatible format.
   *
   * Assigns stable IDs to tool calls in assistant messages and adds the
   * matching `tool_call_id` to subsequent tool result messages so cloud
   * providers don't reject the request.
   */
  _adaptMessagesForOpenAI(messages: ChatMessage[]): AdaptedMessage[] {
    if (!Array.isArray(messages)) return messages as unknown as AdaptedMessage[];

    const adapted: AdaptedMessage[] = [];
    // Ordered list of tool call IDs from the most recent assistant message
    let pendingIds: string[] = [];
    // Map from tool name → queue of IDs (for name-based correlation)
    const pendingByName: Record<string, string[]> = {};

    for (const msg of messages) {
      if (msg && msg.role === "assistant" && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        pendingIds = [];
        Object.keys(pendingByName).forEach(k => delete pendingByName[k]);
        
        const adaptedToolCalls = msg.tool_calls.map((tc, i) => {
          const id = tc.id || `call_${Date.now()}_${i}`;
          pendingIds.push(id);
          const fnName = tc.function?.name;
          if (fnName) {
            if (!pendingByName[fnName]) pendingByName[fnName] = [];
            pendingByName[fnName].push(id);
          }
          // OpenAI-compatible APIs require arguments as a JSON string
          let args = tc.function?.arguments;
          if (typeof args !== "string") {
            args = JSON.stringify(args || {});
          }
          return {
            id,
            type: "function" as const,
            function: {
              name: tc.function!.name,
              arguments: args as string,
            },
          };
        });
        adapted.push({ ...msg, tool_calls: adaptedToolCalls } as AdaptedMessage);
        continue;
      }

      if (msg && msg.role === "tool" && !msg.tool_call_id) {
        const toolName = msg.name;
        let chosenId: string | undefined;

        if (toolName && pendingByName[toolName] && pendingByName[toolName].length > 0) {
          chosenId = pendingByName[toolName].shift();
          // Also remove from ordered queue
          if (chosenId) {
            const idx = pendingIds.indexOf(chosenId);
            if (idx !== -1) pendingIds.splice(idx, 1);
          }
        } else if (pendingIds.length > 0) {
          chosenId = pendingIds.shift();
        }

        if (chosenId) {
          adapted.push({ ...msg, tool_call_id: chosenId } as AdaptedMessage);
          continue;
        }
      }

      adapted.push(msg as AdaptedMessage);
    }

    return adapted;
  }

  async *chatStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
    _maxTokens: number = DEFAULT_MAX_TOKENS,
    onRetry?: OnRetryCallback
  ): AsyncGenerator<StreamEvent> {
    const adaptedMessages = this._adaptMessagesForOpenAI(messages);
    const body: Record<string, unknown> = {
      model: this._model,
      messages: adaptedMessages,
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
        let errorBody = "";
        try { errorBody = await resp.text(); } catch { /* ignore */ }
        const { message, actionable } = formatAPIError(resp.status, errorBody, this._providerName, this._envVar());
        const err = new Error(actionable ? `${message}\n  → ${actionable}` : message) as Error & { status: number; body: string };
        err.status = resp.status;
        err.body = errorBody;
        throw err;
      }
      return resp;
    }, MAX_RETRIES, onRetry);

    const reader = response.body?.getReader();
    if (!reader) {
      yield { type: "done", toolCalls: [], tokenUsage: { promptTokens: 0, completionTokens: 0 } };
      return;
    }
    
    const decoder = new TextDecoder();
    let buffer = "";
    const toolCallsById = new Map<number, { id: string | null; function: { name: string; arguments: string } }>();
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

          let data: { choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }> } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
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
              const idx = tc.index ?? 0;
              if (!toolCallsById.has(idx)) {
                toolCallsById.set(idx, { id: tc.id || null, function: { name: "", arguments: "" } });
              }
              const existing = toolCallsById.get(idx)!;
              if (tc.id && !existing.id) existing.id = tc.id;
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

    // Parse accumulated tool call arguments — always produce an object
    const toolCalls = [...toolCallsById.values()].map(tc => {
      const rawArgs = tc.function.arguments;
      let args: Record<string, unknown> = {};
      if (rawArgs && typeof rawArgs === "string") {
        try {
          const parsed = JSON.parse(rawArgs);
          if (parsed && typeof parsed === "object") {
            args = parsed;
          }
        } catch {
          // Malformed JSON from provider — fall back to empty object
        }
      } else if (rawArgs && typeof rawArgs === "object") {
        args = rawArgs as Record<string, unknown>;
      }
      return { id: tc.id || undefined, function: { name: tc.function.name, arguments: args } };
    });

    yield {
      type: "done",
      toolCalls,
      tokenUsage: { promptTokens, completionTokens },
    };
  }

  async chatWithRetry(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
    _maxTokens: number = DEFAULT_MAX_TOKENS,
    onRetry?: OnRetryCallback
  ): Promise<ChatResponse> {
    const adaptedMessages = this._adaptMessagesForOpenAI(messages);
    const body: Record<string, unknown> = {
      model: this._model,
      messages: adaptedMessages,
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
        let errorBody = "";
        try { errorBody = await resp.text(); } catch { /* ignore */ }
        const { message, actionable } = formatAPIError(resp.status, errorBody, this._providerName, this._envVar());
        const err = new Error(actionable ? `${message}\n  → ${actionable}` : message) as Error & { status: number; body: string };
        err.status = resp.status;
        err.body = errorBody;
        throw err;
      }
      return resp.json();
    }, MAX_RETRIES, onRetry) as { choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id?: string; function: { name: string; arguments: string | Record<string, unknown> } }> } }> };

    const choice = data.choices?.[0];
    return {
      message: {
        content: choice?.message?.content || "",
        tool_calls: this._normalizeToolCalls(choice?.message?.tool_calls),
      },
    };
  }

  async listModels(): Promise<string[]> {
    try {
      const resp = await fetch(`${this.baseURL}/models`, {
        headers: this._headers(),
      });
      if (!resp.ok) return [];
      const data = await resp.json() as { data?: Array<{ id?: string }> };
      return (data.data || []).map(m => m.id || "");
    } catch {
      return [];
    }
  }

  /**
   * Check if this model supports vision (image inputs).
   * Vision-capable models for OpenAI-compatible providers include:
   *   - OpenAI: gpt-4o, gpt-4-turbo, gpt-4-vision, gpt-4.1, o1
   *   - Grok: all grok models support vision
   *   - Gemini: all gemini models support vision
   */
  supportsVision(): boolean {
    const model = this._model.toLowerCase();
    // Gemini models all support vision
    if (this._providerName === 'gemini' || model.includes('gemini')) {
      return true;
    }
    // Grok models all support vision
    if (this._providerName === 'grok' || model.includes('grok')) {
      return true;
    }
    // OpenAI vision models
    if (model.includes('gpt-4o') || model.includes('gpt-4-turbo') ||
        model.includes('gpt-4-vision') || model.includes('gpt-4.1') ||
        model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) {
      return true;
    }
    // Claude models via OpenAI-compatible endpoints support vision
    if (model.includes('claude')) {
      return true;
    }
    return false;
  }
}