/**
 * Accurate token estimation using tiktoken.
 * 
 * Uses the cl100k_base encoding which works well for:
 * - GPT-4 / GPT-4o
 * - GPT-3.5-turbo
 * - Most modern LLMs (Llama, Qwen, Mistral use similar tokenizers)
 * 
 * Falls back to character-based estimation if tiktoken fails to load.
 */

import { logger } from './logger.js';

let encoding = null;
let tiktokenAvailable = false;

// Lazy-load tiktoken
async function initTiktoken() {
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
    logger.warn(`tiktoken not available, falling back to character-based estimation: ${error.message}`);
    encoding = false;
    tiktokenAvailable = false;
    return false;
  }
}

// Initialize on import
initTiktoken();

/**
 * Estimate token count for text using tiktoken if available.
 * Falls back to character-based estimation.
 */
export function estimateTokens(text) {
  if (!text) return 0;
  
  if (encoding && typeof encoding.encode === 'function') {
    try {
      const tokens = encoding.encode(text);
      return tokens.length;
    } catch (error) {
      // Fall through to character-based estimation
      logger.debug(`tiktoken encode error: ${error.message}`);
    }
  }
  
  // Fallback: ~4 characters per token for English, ~2 for code-heavy content
  // This is a rough approximation
  const str = typeof text === 'string' ? text : String(text);
  return Math.ceil(str.length / 4);
}

/**
 * Estimate token count for a single message.
 * Includes overhead for message structure (role, name, etc.)
 */
export function estimateMessageTokens(msg) {
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
export function estimateTotalTokens(messages) {
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
 * Get a detailed breakdown of token usage by message.
 */
export function getTokenBreakdown(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { total: 0, byRole: {}, byMessage: [] };
  }
  
  const byRole = {};
  const byMessage = [];
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
      preview: msg.content ? msg.content.substring(0, 50).replace(/\n/g, ' ') + '...' : '',
    });
  }
  
  total += 4; // Response overhead
  
  return { total, byRole, byMessage };
}

/**
 * Check if tiktoken is available.
 */
export function isTiktokenAvailable() {
  return tiktokenAvailable;
}

/**
 * Get token count for a string using the best available method.
 * This is the primary function to use for simple text.
 */
export function countTokens(text) {
  return estimateTokens(text);
}

/**
 * Free tiktoken resources (call during cleanup).
 */
export async function cleanup() {
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