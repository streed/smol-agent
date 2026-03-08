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
 */

import { classifyError, isContextOverflowError } from "../errors.js";

const MAX_RETRIES = 3;

// ── Rate limiting (shared across providers) ────────────────────────

const DEFAULT_RATE_LIMIT = {
  requestsPerMinute: 30,
  requestsPerSecond: 1,
  maxConcurrent: 1,
  rateLimitBackoffMs: 5000,
};

class TokenBucket {
  constructor(capacity, refillRate) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillRate = refillRate;
    this.lastRefill = Date.now();
  }

  acquire(tokens = 1) {
    this.refill();
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return { ok: true, waitMs: 0 };
    }
    return { ok: false, waitMs: ((tokens - this.tokens) / this.refillRate) * 1000 };
  }

  refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

export class BaseLLMProvider {
  constructor({ model, rateLimitConfig } = {}) {
    this._model = model;
    this._rateLimiter = null;
    this._recent429Count = 0;
    this._last429Time = 0;
    this._rateLimitConfig = rateLimitConfig || DEFAULT_RATE_LIMIT;
  }

  /** Provider name for display/logging. */
  get name() {
    throw new Error("Subclass must implement get name()");
  }

  /** Current model identifier. */
  get model() {
    return this._model;
  }

  set model(value) {
    this._model = value;
  }

  /**
   * Convert the generic tool format to the provider's expected format.
   * Default implementation returns the Ollama/OpenAI-compatible format.
   * Override for providers with different tool schemas.
   */
  formatTools(tools) {
    return tools;
  }

  /**
   * Streaming chat — async generator yielding token and done events.
   * Must be implemented by subclasses.
   */
  async *chatStream(_messages, _tools, _signal, _maxTokens, _onRetry) {
    throw new Error("Subclass must implement chatStream()");
  }

  /**
   * Non-streaming chat — returns { message: { content, tool_calls } }.
   * Must be implemented by subclasses.
   */
  async chatWithRetry(_messages, _tools, _signal, _maxTokens, _onRetry) {
    throw new Error("Subclass must implement chatWithRetry()");
  }

  /** List available models. Returns an array of model name strings. */
  async listModels() {
    return [];
  }

  /**
   * Rough token estimate — only used for pre-call context-size heuristics.
   * Override for provider-specific tokenization.
   */
  estimateTokenCount(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return 0;
    let chars = 0;
    for (const m of messages) {
      if (m.content) chars += m.content.length;
      if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
    }
    return Math.ceil(chars / 4);
  }

  /**
   * Summarize messages using a simpler/cheaper call.
   * Used by context-summarizer. Override if the provider has special
   * summarization capabilities or needs a different API path.
   */
  async summarize(messages) {
    const response = await this.chatWithRetry(messages, [], null, 4096);
    return response.message?.content || "";
  }

  // ── Rate limiting (shared) ──────────────────────────────────────

  _getRateLimiter() {
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

  async _waitForRateLimit() {
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

  _rateLimitBackoff(attempt) {
    return this._rateLimitConfig.rateLimitBackoffMs * Math.pow(2, attempt - 1) + Math.random() * 1000;
  }

  // ── Retry logic (shared) ───────────────────────────────────────

  async _withRetry(fn, maxRetries = MAX_RETRIES, onRetry) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await this._waitForRateLimit();
        const result = await fn();
        this._recent429Count = 0;
        return result;
      } catch (err) {
        lastError = err;

        if (isContextOverflowError(err)) {
          const error = new Error("Context limit exceeded");
          error.code = "CONTEXT_OVERFLOW";
          error.originalError = err;
          throw error;
        }

        if (err.status === 429 || err.message?.includes("rate limit")) {
          this._recent429Count++;
          this._last429Time = Date.now();
          if (attempt < maxRetries) {
            const delayMs = this._rateLimitBackoff(attempt);
            onRetry?.({ attempt, maxRetries, error: err, delayMs });
            await new Promise((r) => setTimeout(r, delayMs));
            continue;
          }
        }

        if (attempt < maxRetries && classifyError(err) === "transient") {
          const delayMs = Math.random() * Math.pow(2, attempt) * 200;
          onRetry?.({ attempt, maxRetries, error: err, delayMs });
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }

        throw err;
      }
    }
    throw lastError;
  }
}

export { MAX_RETRIES };
