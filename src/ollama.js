import { Ollama } from "ollama";
import { classifyError, isContextOverflowError } from "./errors.js";

const DEFAULT_MODEL = process.env.SMOL_AGENT_MODEL || "qwen2.5-coder:32b";
const DEFAULT_MAX_TOKENS = 128000;
const MAX_RETRIES = 3;
const MIN_CONTEXT = 16384;

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

let rateLimiter = null;
let recent429Count = 0;
let last429Time = 0;

function getRateLimiter() {
  if (!rateLimiter) {
    const rpm = Math.max(1, parseInt(process.env.OLLAMA_RATE_LIMIT_PER_MINUTE) || DEFAULT_RATE_LIMIT.requestsPerMinute);
    const rps = Math.max(1, parseInt(process.env.OLLAMA_RATE_LIMIT_PER_SECOND) || DEFAULT_RATE_LIMIT.requestsPerSecond);
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
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(chars / 4);
}

/**
 * Calculate num_ctx for the Ollama request.
 * Scales with conversation size but keeps a floor and ceiling.
 */
function calculateNumCtx(messages, maxTokens) {
  const estTokens = estimateTokenCount(messages);
  return Math.min(Math.max(Math.ceil(estTokens * 1.5), MIN_CONTEXT), maxTokens);
}

// ── Retry logic ─────────────────────────────────────────────────────

/**
 * Execute an async function with retry, rate limiting, and error classification.
 * Handles context overflow (no retry), 429s (backoff), and transient errors.
 *
 * @param {Function} fn — async function to execute
 * @param {number} maxRetries
 * @param {Function} [onRetry] — called before each retry sleep: onRetry({ attempt, maxRetries, error, delayMs })
 */
async function withRetry(fn, maxRetries = MAX_RETRIES, onRetry) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await waitForRateLimit();
      const result = await fn();
      recent429Count = 0;
      return result;
    } catch (err) {
      lastError = err;

      // Context overflow errors should not be retried — need to prune messages
      if (isContextOverflowError(err)) {
        const error = new Error("Context limit exceeded");
        error.code = "CONTEXT_OVERFLOW";
        error.originalError = err;
        throw error;
      }

      if (err.status === 429 || err.message?.includes("rate limit")) {
        recent429Count++;
        last429Time = Date.now();
        if (attempt < maxRetries) {
          const delayMs = rateLimitBackoff(attempt);
          onRetry?.({ attempt, maxRetries, error: err, delayMs });
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
      }

      if (attempt < maxRetries && classifyError(err) === 'transient') {
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

// ── Streaming chat ───────────────────────────────────────────────────

/**
 * Streaming chat — async generator that yields:
 *   { type: "token",  content: string }
 *   { type: "done",   toolCalls: [], tokenUsage: { promptTokens, completionTokens } }
 *
 * Retry logic covers connection establishment only; once the stream is
 * open and tokens are flowing, a mid-stream failure will propagate.
 *
 * @param {Function} [onRetry] — forwarded to withRetry
 */
export async function* chatStream(
  client, model, messages, tools, signal,
  maxTokens = DEFAULT_MAX_TOKENS, onRetry,
) {
  const numCtx = calculateNumCtx(messages, maxTokens);

  const stream = await withRetry(() =>
    client.chat({
      model: model || DEFAULT_MODEL,
      messages,
      tools,
      stream: true,
      options: { num_ctx: numCtx },
      signal,
    }),
    MAX_RETRIES,
    onRetry,
  );

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

// ── Non-streaming chat (kept for sub-agent / simple calls) ───────────

export async function chatWithRetry(
  client, model, messages, tools, signal,
  maxTokens = DEFAULT_MAX_TOKENS, onRetry,
) {
  const numCtx = calculateNumCtx(messages, maxTokens);

  return withRetry(() =>
    client.chat({
      model: model || DEFAULT_MODEL,
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

/** List available models from Ollama. */
export async function listModels(client) {
  try {
    const response = await client.list();
    return response.models || [];
  } catch {
    return [];
  }
}

export { DEFAULT_MODEL };
