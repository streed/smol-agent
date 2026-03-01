/**
 * Conversation utilities - token estimation
 * 
 * @deprecated Use token-estimator.js instead for accurate tiktoken-based estimation.
 * This file is kept for backwards compatibility.
 */

import { 
  estimateTotalTokens, 
  getTokenBreakdown as getBreakdown,
  estimateMessageTokens,
  estimateTokens
} from './token-estimator.js';

/**
 * Estimate token count from messages
 * @param {Array} messages - Array of message objects
 * @returns {number} - Estimated token count
 * @deprecated Use estimateTotalTokens from token-estimator.js
 */
export function estimateTokenCount(messages) {
  return estimateTotalTokens(messages);
}

/**
 * Get detailed token breakdown for debugging/display
 * @param {Array} messages - Array of message objects
 * @returns {Object} - Token breakdown with role details
 * @deprecated Use getTokenBreakdown from token-estimator.js
 */
export function getTokenBreakdown(messages) {
  return getBreakdown(messages);
}

export default {
  estimateTokenCount,
  getTokenBreakdown,
  // Re-export new functions for convenience
  estimateTotalTokens,
  estimateMessageTokens,
  estimateTokens,
};