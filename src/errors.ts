/**
 * Shared error classification utilities.
 *
 * Centralises the context-overflow detection that was duplicated in
 * ollama.js and context-manager.js, and adds a general classifier
 * used by retry logic.
 *
 * Key exports:
 *   - isContextOverflowError(err): Check if error indicates context limit hit
 *   - classifyError(err): Classify error as transient/model_error/logic_error
 *   - formatUserError(err): Convert error to user-friendly message
 *
 * Dependencies: None (pure utility)
 * Depended on by: src/agent.js, src/constants.js, src/context-manager.js, src/cross-agent.js,
 *                 src/index.js, src/input-parser.js, src/logger.js, src/providers/anthropic.js,
 *                 src/providers/base.js, src/providers/errors.js, src/providers/openai-compatible.js,
 *                 src/shift-left.js, src/token-estimator.js, src/tools/registry.js, src/tools/sub_agent.js,
 *                 src/tools/web_search.js, src/ts-lint.js, test/unit/errors.test.js
 */

const OVERFLOW_PATTERNS: readonly string[] = [
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

/**
 * Error classification type
 */
export type ErrorClass = 'transient' | 'context_overflow' | 'model_error' | 'logic_error' | 'abort';

/**
 * Extended error type with additional properties
 */
export interface SmolAgentError extends Error {
  code?: string;
  status?: number;
  error?: string | Error;
}

/**
 * Returns true when the error indicates the LLM's context window has
 * been exceeded. Works with both Error objects and plain strings.
 */
export function isContextOverflowError(err: unknown): boolean {
  if (!err) return false;
  
  let raw: string;
  if (err instanceof Error) {
    const smolErr = err as SmolAgentError;
    raw = smolErr.message || 
          (typeof smolErr.error === 'string' ? smolErr.error : (smolErr.error as Error)?.message) || 
          String(err);
  } else if (typeof err === 'string') {
    raw = err;
  } else if (typeof err === 'object' && err !== null) {
    // Handle nested error objects like { error: { message: '...' } }
    const obj = err as Record<string, unknown>;
    const errorProp = obj.error;
    if (typeof errorProp === 'string') {
      raw = errorProp;
    } else if (errorProp && typeof errorProp === 'object' && 'message' in (errorProp as object)) {
      raw = String((errorProp as { message: unknown }).message);
    } else if ('message' in obj) {
      raw = String(obj.message);
    } else {
      raw = JSON.stringify(err);
    }
  } else {
    raw = String(err);
  }
  
  const msg = raw.toLowerCase();
  return OVERFLOW_PATTERNS.some(p => msg.includes(p));
}

/**
 * Classify an error for retry / backoff decisions.
 */
export function classifyError(err: unknown): ErrorClass {
  if (!err) return 'logic_error';
  
  const smolErr = err as SmolAgentError;

  // AbortError — explicit cancellation, not retryable
  if (smolErr.name === 'AbortError') return 'abort';

  if (isContextOverflowError(err)) return 'context_overflow';

  // Network / rate-limit — safe to retry
  if (
    smolErr.code === 'ECONNREFUSED' ||
    smolErr.code === 'ETIMEDOUT' ||
    smolErr.code === 'ECONNRESET' ||
    smolErr.code === 'ENOTFOUND' ||
    smolErr.code === 'EAI_AGAIN' ||
    smolErr.code === 'EPIPE' ||
    smolErr.code === 'ECONNABORTED' ||
    smolErr.status === 429 ||
    (smolErr.status !== undefined && smolErr.status >= 500 && smolErr.status < 600) ||
    smolErr.message?.toLowerCase().includes('timeout') ||
    smolErr.message?.toLowerCase().includes('deadline') ||
    smolErr.message?.toLowerCase().includes('rate limit') ||
    smolErr.message?.includes('slot unavailable')
  ) {
    return 'transient';
  }

  // 4xx (not 429) from the API — usually bad request / model issue
  if (smolErr.status !== undefined && smolErr.status >= 400 && smolErr.status < 500) return 'model_error';

  return 'logic_error';
}

/**
 * Map an error to a short, actionable message for the user.
 */
export function formatUserError(err: unknown, model?: string, provider: string = 'ollama'): string {
  if (!err) return 'Unknown error.';
  
  const smolErr = err as SmolAgentError;
  const providerName = provider.charAt(0).toUpperCase() + provider.slice(1);

  if (smolErr.code === 'ECONNREFUSED') {
    if (provider === 'ollama') {
      return 'Cannot connect to Ollama. Is it running? Try: `ollama serve`';
    }
    return `Cannot connect to ${providerName}. Check that the server is running.`;
  }
  if (smolErr.code === 'ENOTFOUND' || smolErr.code === 'EAI_AGAIN') {
    if (provider === 'ollama') {
      return 'Cannot resolve Ollama host. Check OLLAMA_HOST.';
    }
    return `Cannot resolve ${providerName} host. Check the base URL.`;
  }
  if (smolErr.status === 429 || smolErr.message?.toLowerCase().includes('rate limit')) {
    return `Rate limited by ${providerName}. Wait a moment and try again.`;
  }
  if (smolErr.status === 404) {
    const m = model || '<model>';
    if (provider === 'ollama') {
      return `Model not found. Run: \`ollama pull ${m}\``;
    }
    return `Model not found: ${m}. Check that the model name is correct.`;
  }
  if (smolErr.status !== undefined && smolErr.status >= 500 && smolErr.status < 600) {
    return `${providerName} server error (${smolErr.status}). The server may be overloaded.`;
  }
  if (smolErr.code === 'ETIMEDOUT' || smolErr.message?.includes('timeout') || smolErr.message?.includes('deadline')) {
    return 'Request timed out. The model may be loading.';
  }
  if (smolErr.code === 'ECONNRESET') {
    return `Connection reset by ${providerName}. The server may have restarted.`;
  }
  if (isContextOverflowError(err)) {
    return 'Context limit exceeded — conversation is too long.';
  }

  return smolErr.message || String(err);
}