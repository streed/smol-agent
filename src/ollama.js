import { Ollama } from "ollama";
import { logger, isTransientError } from "./logger.js";

const DEFAULT_MODEL = "glm-4.7-flash:latest";
const DEFAULT_MAX_TOKENS = 128000;
const MAX_RETRIES = 3;

// ── Rate limiting ────────────────────────────────────────────────────

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

  async acquire(tokens = 1) {
    this.refill();
    if (this.tokens >= tokens) {
      this.tokens -= tokens;
      return true;
    }
    return ((tokens - this.tokens) / this.refillRate) * 1000;
  }

  refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillRate);
    this.lastRefill = now;
  }
}

let rateLimiter = null;
let recent429Count = 0;
let last429Time = 0;

function getRateLimiter() {
  if (!rateLimiter) {
    const rpm = parseInt(process.env.OLLAMA_RATE_LIMIT_PER_MINUTE) || DEFAULT_RATE_LIMIT.requestsPerMinute;
    const rps = parseInt(process.env.OLLAMA_RATE_LIMIT_PER_SECOND) || DEFAULT_RATE_LIMIT.requestsPerSecond;
    rateLimiter = {
      secondBucket: new TokenBucket(rps * 2, rps),
      minuteBucket: new TokenBucket(rpm, rpm / 60),
    };
  }
  return rateLimiter;
}

async function waitForRateLimit() {
  const buckets = getRateLimiter();

  // Cooldown after repeated 429s
  if (recent429Count > 2 && Date.now() - last429Time < 30000) {
    const wait = 30000 - (Date.now() - last429Time);
    await new Promise((r) => setTimeout(r, wait));
  }

  let wait = await buckets.secondBucket.acquire(1);
  if (wait !== true) await new Promise((r) => setTimeout(r, wait));

  wait = await buckets.minuteBucket.acquire(1);
  if (wait !== true) await new Promise((r) => setTimeout(r, wait));
}

function rateLimitBackoff(attempt) {
  return DEFAULT_RATE_LIMIT.rateLimitBackoffMs * Math.pow(2, attempt - 1) + Math.random() * 1000;
}

// ── Helpers ──────────────────────────────────────────────────────────

export function createClient(host) {
  return new Ollama({ host: host || "http://127.0.0.1:11434" });
}

/**
 * Rough token estimate — only used for pre-call context-size heuristics.
 * After a call completes the real counts from the API are used.
 */
export function estimateTokenCount(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  let chars = 0;
  for (const m of messages) {
    if (m.content) chars += m.content.length;
  }
  return Math.ceil(chars / 4);
}

// ── Streaming chat ───────────────────────────────────────────────────

/**
 * Check if an error indicates context overflow
 */
function isContextOverflowError(err) {
  if (!err) return false;
  const msg = (err.message || err.error || String(err)).toLowerCase();
  
  const patterns = [
    'context length',
    'prompt is too long',
    'maximum context',
    'token limit',
    'sequence length',
    'too many tokens',
    'context window',
    'exceeds maximum',
    'requested tokens',
    'input too long',
  ];
  
  return patterns.some(p => msg.includes(p));
}

/**
 * Open a streaming chat connection with retry on connection failure.
 * Returns the raw async-iterable stream from the Ollama client.
 */
async function connectStream(client, model, messages, tools, signal, maxTokens, maxRetries = MAX_RETRIES) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await waitForRateLimit();

      const estTokens = estimateTokenCount(messages);
      // Scale context window with conversation size, but keep a floor and ceiling.
      // Avoids always maxing out (wastes VRAM/degrades quality on small models).
      const numCtx = Math.min(
        Math.max(Math.ceil(estTokens * 1.5), 16384),
        maxTokens,
      );

      const stream = await client.chat({
        model: model || DEFAULT_MODEL,
        messages,
        tools,
        stream: true,
        options: { num_ctx: numCtx },
        signal,
      });

      recent429Count = 0;
      return stream;
    } catch (err) {
      lastError = err;

      // Context overflow errors should not be retried - need to prune messages
      if (isContextOverflowError(err)) {
        const error = new Error('Context limit exceeded');
        error.code = 'CONTEXT_OVERFLOW';
        error.originalError = err;
        throw error;
      }

      if (err.status === 429 || err.message?.includes("rate limit")) {
        recent429Count++;
        last429Time = Date.now();
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, rateLimitBackoff(attempt)));
          continue;
        }
      }

      if (attempt < maxRetries && isTransientError(err)) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 100));
        continue;
      }

      throw err;
    }
  }
  throw lastError;
}

/**
 * Streaming chat — async generator that yields:
 *   { type: "token",  content: string }        for each text chunk
 *   { type: "done",   toolCalls: [], tokenUsage: { promptTokens, completionTokens } }
 *
 * Retry logic covers connection establishment only; once the stream is
 * open and tokens are flowing, a mid-stream failure will propagate.
 */
export async function* chatStream(
  client, model, messages, tools, signal,
  maxTokens = DEFAULT_MAX_TOKENS,
) {
  const stream = await connectStream(client, model, messages, tools, signal, maxTokens);

  // Accumulate tool_calls across ALL chunks — some models send them on
  // intermediate chunks before the final done=true chunk.
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

  // Stream ended without done=true (shouldn't happen but handle gracefully)
  yield { type: "done", toolCalls: accumulatedToolCalls, tokenUsage: { promptTokens: 0, completionTokens: 0 } };
}

// ── Non-streaming chat (kept for backward compat / simple calls) ────

export async function chatWithRetry(
  client, model, messages, tools, signal,
  maxTokens = DEFAULT_MAX_TOKENS, maxRetries = MAX_RETRIES,
) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await waitForRateLimit();

      const estTokens = estimateTokenCount(messages);
      // Scale context window with conversation size, but keep a floor and ceiling.
      // Avoids always maxing out (wastes VRAM/degrades quality on small models).
      const numCtx = Math.min(
        Math.max(Math.ceil(estTokens * 1.5), 16384),
        maxTokens,
      );

      const response = await client.chat({
        model: model || DEFAULT_MODEL,
        messages,
        tools,
        stream: false,
        options: { num_ctx: numCtx },
        signal,
      });

      recent429Count = 0;
      return response;
    } catch (err) {
      lastError = err;

      // Context overflow errors should not be retried
      if (isContextOverflowError(err)) {
        const error = new Error('Context limit exceeded');
        error.code = 'CONTEXT_OVERFLOW';
        error.originalError = err;
        throw error;
      }

      if (err.status === 429 || err.message?.includes("rate limit")) {
        recent429Count++;
        last429Time = Date.now();
        if (attempt < maxRetries) {
          await new Promise((r) => setTimeout(r, rateLimitBackoff(attempt)));
          continue;
        }
      }

      if (attempt < maxRetries && isTransientError(err)) {
        await new Promise((r) => setTimeout(r, Math.pow(2, attempt) * 100));
        continue;
      }

      throw err;
    }
  }
  throw lastError;
}

export { DEFAULT_MODEL };
