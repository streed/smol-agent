/**
 * Base LLM provider interface.
 *
 * All providers must implement:
 *   - chatStream(messages, tools, signal, maxTokens, onRetry)  → async generator
 *   - chatWithRetry(messages, tools, signal, maxTokens, onRetry) → Promise
 *   - listModels() → Promise<string[]>
 *   - get model → string
 *   - formatTools(tools) → provider-specific tool format
 *
 * Stream events (yielded by chatStream):
 *   { type: "token",  content: string }
 *   { type: "done",   toolCalls: [{ function: { name, arguments } }],
 *                      tokenUsage: { promptTokens, completionTokens } }
 *
 * chatWithRetry returns:
 *   { message: { content, tool_calls } }
 *
 * Tool calls are always normalized to the shape:
 *   { function: { name: string, arguments: object } }
 *
 * Key exports:
 *   - BaseLLMProvider class: Abstract base for all providers
 *   - MAX_RETRIES: Default retry count (3)
 *   - TokenBucket class: Rate limiting utility
 *
 * Dependencies: ../errors.js
 * Depended on by: src/agent-registry.js, src/agent.js, src/architect.js, src/constants.js,
 *                 src/context-manager.js, src/context-summarizer.js, src/context.js,
 *                 src/providers/anthropic.js, src/providers/ollama.js, src/providers/openai-compatible.js,
 *                 src/providers/index.js, src/tools/*.js (all tools), test/unit/*.test.js (extensive)
 */
import { classifyError, isContextOverflowError } from "../errors.js";

export const MAX_RETRIES = 3;

// ── Rate limiting (shared across providers) ────────────────────────────────

export interface RateLimitConfig {
  requestsPerMinute: number;
  requestsPerSecond: number;
  maxConcurrent: number;
  rateLimitBackoffMs: number;
}

const DEFAULT_RATE_LIMIT: RateLimitConfig = {
  requestsPerMinute: 30,
  requestsPerSecond: 1,
  maxConcurrent: 1,
  rateLimitBackoffMs: 5000,
};

export class TokenBucket {
  capacity: number;
  tokens: number;
  refillRate: number;
  lastRefill: number;

  constructor(capacity: number, refillRate: number) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillRate;
    this.lastRefill = Date.now();
  }

  acquire(tokens = 1): { ok: boolean; waitMs: number } {
    this.refill();
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return { ok: true, waitMs: 0 };
    }
    return { ok: false, waitMs: ((tokens - this.tokens) / this.refillRate) * 1000 };
  }

  refill(): void {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

// ── Message types ────────────────────────────────────────────────────────

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface ToolCall {
  id?: string;
  function: {
    name: string;
    arguments: string | Record<string, unknown>;
  };
}

export interface ToolDefinition {
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
  input_schema?: Record<string, unknown>;
}

// ── Stream event types ────────────────────────────────────────────────────

export interface StreamTokenEvent {
  type: "token";
  content: string;
}

export interface StreamDoneEvent {
  type: "done";
  toolCalls?: ToolCall[];
  tokenUsage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

export type StreamEvent = StreamTokenEvent | StreamDoneEvent;

// ── Chat response types ───────────────────────────────────────────────────

export interface ChatResponse {
  message: {
    content?: string;
    tool_calls?: ToolCall[];
  };
  tokenUsage?: {
    promptTokens?: number;
    completionTokens?: number;
  };
}

// ── Retry callback types ───────────────────────────────────────────────────

export interface RetryInfo {
  attempt: number;
  maxRetries: number;
  error: Error;
  delayMs: number;
}

export type OnRetryCallback = (info: RetryInfo) => void;

// ── BaseLLMProvider class ─────────────────────────────────────────────────

export abstract class BaseLLMProvider {
  protected _model: string;
  protected _rateLimiter: { secondBucket: TokenBucket; minuteBucket: TokenBucket } | null = null;
  protected _recent429Count: number = 0;
  protected _last429Time: number = 0;
  protected _rateLimitConfig: RateLimitConfig;

  constructor({ model, rateLimitConfig }: { model?: string; rateLimitConfig?: Partial<RateLimitConfig> } = {}) {
    this._model = model || "";
    this._rateLimitConfig = { ...DEFAULT_RATE_LIMIT, ...rateLimitConfig };
  }

  /** Provider name for display/logging. */
  abstract get name(): string;

  /** Current model identifier. */
  get model(): string {
    return this._model;
  }

  set model(value: string) {
    this._model = value;
  }

  /**
   * Convert the generic tool format to the provider's expected format.
   * Default implementation returns the Ollama/OpenAI-compatible format.
   * Override for providers with different tool schemas.
   */
  formatTools(tools: ToolDefinition[]): unknown {
    return tools;
  }

  /**
   * Streaming chat — async generator yielding token and done events.
   * Must be implemented by subclasses.
   */
  async *chatStream(
    _messages: ChatMessage[],
    _tools: ToolDefinition[],
    _signal?: AbortSignal,
    _maxTokens?: number,
    _onRetry?: OnRetryCallback
  ): AsyncGenerator<StreamEvent> {
    throw new Error("Subclass must implement chatStream()");
  }

  /**
   * Non-streaming chat — returns { message: { content, tool_calls } }.
   * Must be implemented by subclasses.
   */
  async chatWithRetry(
    _messages: ChatMessage[],
    _tools: ToolDefinition[],
    _signal?: AbortSignal,
    _maxTokens?: number,
    _onRetry?: OnRetryCallback
  ): Promise<ChatResponse> {
    throw new Error("Subclass must implement chatWithRetry()");
  }

  /** List available models. Returns an array of model name strings. */
  async listModels(): Promise<string[]> {
    return [];
  }

  /**
   * Rough token estimate — only used for pre-call context-size heuristics.
   * Override for provider-specific tokenization.
   */
  estimateTokenCount(messages: ChatMessage[]): number {
    if (!Array.isArray(messages) || messages.length === 0) return 0;
    let chars = 0;
    for (const m of messages) {
      if (m.content) {
        if (typeof m.content === "string") {
          chars += m.content.length;
        } else {
          chars += m.content.map(p => p.text || "").join("").length;
        }
      }
      if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
    }
    return Math.ceil(chars / 4);
  }

  /**
   * Summarize messages using a simpler/cheaper call.
   * Used by context-summarizer. Override if the provider has special
   * summarization capabilities or needs a different API path.
   */
  async summarize(messages: ChatMessage[]): Promise<string> {
    const response = await this.chatWithRetry(messages, [], null, 4096);
    return response.message?.content || "";
  }

  /**
   * Check if this provider/model supports vision (image inputs).
   * Override in subclasses for provider-specific detection.
   */
  supportsVision(): boolean {
    return false;
  }

  // ── Rate limiting (shared) ──────────────────────────────────────────────

  protected _getRateLimiter(): { secondBucket: TokenBucket; minuteBucket: TokenBucket } {
    if (!this._rateLimiter) {
      const rpm = this._rateLimitConfig.requestsPerMinute;
      const rps = this._rateLimitConfig.requestsPerSecond;
      this._rateLimiter = {
        secondBucket: new TokenBucket(rps * 2, rps),
        minuteBucket: new TokenBucket(rpm, rpm / 60),
      };
    }
    return this._rateLimiter;
  }

  protected async _waitForRateLimit(): Promise<void> {
    const buckets = this._getRateLimiter();

    if (this._recent429Count > 2 && Date.now() - this._last429Time < 30000) {
      const wait = 30000 - (Date.now() - this._last429Time);
      await new Promise((r) => setTimeout(r, wait));
    }

    while (true) {
      const result = buckets.secondBucket.acquire(1);
      if (result.ok) break;
      await new Promise((r) => setTimeout(r, result.waitMs));
    }

    while (true) {
      const result = buckets.minuteBucket.acquire(1);
      if (result.ok) break;
      await new Promise((r) => setTimeout(r, result.waitMs));
    }
  }

  protected _rateLimitBackoff(attempt: number): number {
    return this._rateLimitConfig.rateLimitBackoffMs * Math.pow(2, attempt - 1) + Math.random() * 1000;
  }

  // ── Retry logic (shared) ───────────────────────────────────────────────

  protected async _withRetry<T>(
    fn: () => Promise<T>,
    maxRetries: number = MAX_RETRIES,
    onRetry?: OnRetryCallback
  ): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this._waitForRateLimit();
        const result = await fn();
        this._recent429Count = 0;
        return result;
      } catch (err) {
        lastError = err as Error;

        if (isContextOverflowError(err)) {
          const error = new Error("Context limit exceeded") as Error & { code: string; originalError: unknown };
          error.code = "CONTEXT_OVERFLOW";
          error.originalError = err;
          throw error;
        }

        const httpErr = err as Error & { status?: number; message?: string };
        if (httpErr.status === 429 || httpErr.message?.includes("rate limit")) {
          this._recent429Count++;
          this._last429Time = Date.now();
          if (attempt < maxRetries) {
            const delayMs = this._rateLimitBackoff(attempt);
            onRetry?.({ attempt, maxRetries, error: err as Error, delayMs });
            await new Promise((r) => setTimeout(r, delayMs));
            continue;
          }
        }

        if (attempt < maxRetries && classifyError(err) === "transient") {
          const delayMs = Math.random() * Math.pow(2, attempt) * 200;
          onRetry?.({ attempt, maxRetries, error: err as Error, delayMs });
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }

        throw err;
      }
    }
    throw lastError;
  }
}