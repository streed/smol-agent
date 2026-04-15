/**
 * Accurate token estimation using tiktoken.
 *
 * Uses the cl100k_base encoding which works well for:
 * - GPT-4 / GPT-4o
 * - GPT-3.5-turbo
 * - Most modern LLMs (Llama, Qwen, Mistral use similar tokenizers)
 *
 * Falls back to character-based estimation if tiktoken fails to load.
 *
 * Key exports:
 *   - estimateTokens(text): Count tokens in text
 *   - estimateMessageTokens(message): Count tokens in a chat message
 *   - estimateTotalTokens(messages): Count total tokens in conversation
 *   - getTokenBreakdown(messages): Get detailed token breakdown
 *   - isTiktokenAvailable(): Check if tiktoken loaded successfully
 *   - countTokens(text): Alias for estimateTokens
 *   - ensureInitialized(): Wait for tiktoken to finish loading
 *
 * Dependencies: ./logger.js, tiktoken (optional)
 * Depended on by: src/agent.js, src/context-manager.js, src/index.js,
 *                  test/unit/token-estimator.test.js
 */

import { logger } from './logger.js';

// Tiktoken encoding type
interface TiktokenEncoding {
  encode: (text: string) => Uint32Array;
  free: () => void;
}

let encoding: TiktokenEncoding | false | null = null;
let tiktokenAvailable = false;
let _initPromise: Promise<boolean> | null = null;

// Lazy-load tiktoken
async function initTiktoken(): Promise<boolean> {
  if (encoding !== null) return encoding !== false;

  try {
    const tiktoken = await import('tiktoken');
    // cl100k_base is the encoding for GPT-4/GPT-3.5-turbo
    // It's a good approximation for most modern LLMs
    encoding = tiktoken.get_encoding('cl100k_base');
    tiktokenAvailable = true;
    logger.debug('tiktoken initialized successfully');
    return true;
  } catch (error) {
    const err = error as Error;
    logger.warn(`tiktoken not available, falling back to character-based estimation: ${err.message}`);
    encoding = false;
    tiktokenAvailable = false;
    return false;
  }
}

// Initialize on import — store promise so callers can await it
_initPromise = initTiktoken();

/**
 * Wait for tiktoken to finish initializing.
 * Call this during agent startup to ensure accurate token counts from the start.
 */
export async function ensureInitialized(): Promise<void> {
  if (_initPromise) await _initPromise;
}

/**
 * Estimate token count for text using tiktoken if available.
 * Falls back to character-based estimation.
 */
export function estimateTokens(text: string | unknown): number {
  if (!text) return 0;

  if (encoding && typeof encoding.encode === 'function') {
    try {
      const tokens = encoding.encode(String(text));
      return tokens.length;
    } catch (error) {
      // Fall through to character-based estimation
      const err = error as Error;
      logger.debug(`tiktoken encode error: ${err.message}`);
    }
  }

  // Fallback: ~4 characters per token for English, ~2 for code-heavy content
  // This is a rough approximation
  const str = typeof text === 'string' ? text : String(text);
  return Math.ceil(str.length / 4);
}

/**
 * Message format for token estimation.
 */
export interface TokenEstimateMessage {
  role: string;
  content?: string | unknown;
  name?: string;
  tool_calls?: Array<{
    function?: {
      name?: string;
      arguments?: string | Record<string, unknown>;
    };
  }>;
}

/**
 * Estimate token count for a single message.
 * Includes overhead for message structure (role, name, etc.)
 */
export function estimateMessageTokens(msg: TokenEstimateMessage): number {
  let tokens = 4; // Base overhead for message structure (role, content markers)

  if (msg.role) {
    tokens += estimateTokens(msg.role);
    tokens += 2; // Role marker overhead
  }

  if (msg.content) {
    tokens += estimateTokens(msg.content);
  }

  if (msg.name) {
    tokens += estimateTokens(msg.name);
    tokens += 1; // Name marker overhead
  }

  // Tool calls have additional overhead
  if (msg.tool_calls) {
    tokens += 3; // Tool calls array overhead
    for (const tc of msg.tool_calls) {
      if (tc.function?.name) {
        tokens += estimateTokens(tc.function.name);
      }
      if (tc.function?.arguments) {
        // Arguments are often JSON strings
        const argsStr = typeof tc.function.arguments === 'string'
          ? tc.function.arguments
          : JSON.stringify(tc.function.arguments);
        tokens += estimateTokens(argsStr);
      }
      tokens += 5; // Per-tool-call overhead
    }
  }

  return tokens;
}

/**
 * Estimate total tokens for an array of messages.
 */
export function estimateTotalTokens(messages: TokenEstimateMessage[]): number {
  if (!Array.isArray(messages)) return 0;

  let total = 3; // Conversation overhead (priming)

  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }

  // Add tokens for the assistant's response (budget for generation)
  total += 4; // Response priming tokens

  return total;
}

/**
 * Token breakdown by role.
 */
export interface TokenBreakdownByRole {
  [role: string]: number;
}

/**
 * Token breakdown by message.
 */
export interface TokenBreakdownMessage {
  index: number;
  role: string;
  tokens: number;
  preview: string;
}

/**
 * Complete token breakdown.
 */
export interface TokenBreakdown {
  total: number;
  byRole: TokenBreakdownByRole;
  byMessage: TokenBreakdownMessage[];
}

/**
 * Get a detailed breakdown of token usage by message.
 */
export function getTokenBreakdown(messages: TokenEstimateMessage[]): TokenBreakdown {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { total: 0, byRole: {}, byMessage: [] };
  }

  const byRole: TokenBreakdownByRole = {};
  const byMessage: TokenBreakdownMessage[] = [];
  let total = 3; // Conversation overhead

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    const msgTokens = estimateMessageTokens(msg);
    total += msgTokens;

    byRole[msg.role] = (byRole[msg.role] || 0) + msgTokens;
    byMessage.push({
      index: i,
      role: msg.role,
      tokens: msgTokens,
      preview: msg.content ? String(msg.content).substring(0, 50).replace(/\n/g, ' ') + '...' : '',
    });
  }

  total += 4; // Response overhead

  return { total, byRole, byMessage };
}

/**
 * Check if tiktoken is available.
 */
export function isTiktokenAvailable(): boolean {
  return tiktokenAvailable;
}

/**
 * Get token count for a string using the best available method.
 * This is the primary function to use for simple text.
 */
export function countTokens(text: string): number {
  return estimateTokens(text);
}

/**
 * Free tiktoken resources (call during cleanup).
 */
export async function cleanup(): Promise<void> {
  if (encoding && typeof encoding.free === 'function') {
    try {
      encoding.free();
    } catch {
      // Ignore errors during cleanup
    }
  }
  encoding = null;
  tiktokenAvailable = false;
}

export default {
  estimateTokens,
  estimateMessageTokens,
  estimateTotalTokens,
  getTokenBreakdown,
  isTiktokenAvailable,
  countTokens,
  cleanup,
};