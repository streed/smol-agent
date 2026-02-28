/**
 * Context management for conversation history.
 * 
 * Handles:
 * - Token counting and budget tracking
 * - Proactive pruning before hitting limits
 * - Summarization of old messages
 * - Truncation of large tool results
 */

import { logger } from './logger.js';
import { isContextOverflowError as _isOverflow } from './errors.js';

// Configuration
const DEFAULT_MAX_TOKENS = 128000;
const PRUNE_THRESHOLD = 0.70;      // Start pruning at 70% capacity
const CRITICAL_THRESHOLD = 0.85;   // Aggressive pruning at 85%
const MIN_KEEP_MESSAGES = 6;       // Always keep last N user/assistant pairs
const MAX_TOOL_RESULT_SIZE = 15000; // Max chars for tool results (prevents context bloat)
const SUMMARY_THRESHOLD = 0.60;    // Summarize old messages at 60%

/**
 * Estimate tokens from text (rough approximation)
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Estimate token count for a message
 */
function estimateMessageTokens(msg) {
  let tokens = 50; // Overhead for message structure
  if (msg.content) tokens += estimateTokens(msg.content);
  if (msg.role) tokens += estimateTokens(msg.role);
  if (msg.name) tokens += estimateTokens(msg.name);
  return tokens;
}

/**
 * Estimate total tokens in messages array
 */
export function estimateTotalTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

/**
 * Context Manager class
 */
export class ContextManager {
  constructor(maxTokens = DEFAULT_MAX_TOKENS) {
    this.maxTokens = maxTokens;
    this.lastPromptTokens = 0; // Actual count from API when available
    this.lastCompletionTokens = 0;
  }

  /**
   * Get current token usage (prefer API counts over estimates)
   */
  getUsage(messages) {
    const used = this.lastPromptTokens || estimateTotalTokens(messages);
    const percentage = Math.round((used / this.maxTokens) * 100);
    return {
      used,
      max: this.maxTokens,
      percentage,
      remaining: this.maxTokens - used,
    };
  }

  /**
   * Check if context is approaching limits
   */
  getStatus(messages) {
    const usage = this.getUsage(messages);
    const pct = usage.percentage / 100; // Convert to 0-1 range for threshold comparisons
    return {
      usage,
      shouldPrune: pct >= PRUNE_THRESHOLD,
      isCritical: pct >= CRITICAL_THRESHOLD,
      shouldSummarize: pct >= SUMMARY_THRESHOLD,
    };
  }

  /**
   * Truncate large tool results to prevent context bloat
   */
  truncateToolResult(result) {
    if (!result) return result;
    
    const str = typeof result === 'string' ? result : JSON.stringify(result);
    
    if (str.length <= MAX_TOOL_RESULT_SIZE) {
      return result;
    }
    
    // Truncate and add indicator
    const truncated = str.substring(0, MAX_TOOL_RESULT_SIZE);
    const indicator = '\n\n[... output truncated to save context space ...]';
    
    logger.warn(`Truncated large tool result (${str.length} -> ${truncated.length} chars)`);
    
    return typeof result === 'string' 
      ? truncated + indicator 
      : { truncated: true, content: truncated + indicator };
  }

  /**
   * Prune conversation history to free up context space.
   * Keeps system message + recent messages.
   */
  pruneMessages(messages, options = {}) {
    const { aggressive = false, keepSystem = true } = options;
    const status = this.getStatus(messages);

    if (!status.shouldPrune && !aggressive) {
      return { messages, pruned: 0 };
    }

    if (messages.length <= MIN_KEEP_MESSAGES + 1) {
      logger.warn('Cannot prune further - minimum messages reached');
      return { messages, pruned: 0 };
    }

    const systemMsg = keepSystem && messages[0]?.role === 'system' ? messages[0] : null;
    const restMessages = keepSystem && systemMsg ? messages.slice(1) : messages;

    // Calculate how many messages to keep based on current usage
    const overageRatio = status.usage.percentage / 100;
    const targetPercentage = aggressive || overageRatio > 1.5 ? 0.30 : 0.50;
    const targetTokens = Math.floor(this.maxTokens * targetPercentage);

    // Work backwards from end to find how many to keep
    let keptTokens = 0;
    const messagesToKeep = [];

    for (let i = restMessages.length - 1; i >= 0; i--) {
      const msgTokens = estimateMessageTokens(restMessages[i]);
      if (messagesToKeep.length >= MIN_KEEP_MESSAGES && keptTokens + msgTokens > targetTokens) {
        break;
      }
      messagesToKeep.unshift(restMessages[i]);
      keptTokens += msgTokens;
    }

    const prunedCount = restMessages.length - messagesToKeep.length;
    if (prunedCount > 0) {
      // Build a breadcrumb summarising what was pruned
      const pruned = restMessages.slice(0, prunedCount);
      const toolsUsed = new Set();
      const userTopics = [];

      for (const msg of pruned) {
        if (msg._summarized) continue;
        if (msg.role === 'tool') {
          try {
            const parsed = JSON.parse(msg.content);
            if (parsed?.name) toolsUsed.add(parsed.name);
          } catch { /* ignore */ }
        }
        if (msg.role === 'assistant' && msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            if (tc.function?.name) toolsUsed.add(tc.function.name);
          }
        }
        if (msg.role === 'user' && !msg._summarized && userTopics.length < 3) {
          userTopics.push(truncateText(msg.content, 80));
        }
      }

      const parts = [`${prunedCount} earlier messages removed.`];
      if (toolsUsed.size > 0) parts.push(`Tools used: ${[...toolsUsed].join(', ')}.`);
      if (userTopics.length > 0) parts.push(`Topics: ${userTopics.join(' | ')}`);

      const breadcrumb = {
        role: 'user',
        content: `[Context compacted: ${parts.join(' ')}]`,
        _summarized: true,
      };

      messagesToKeep.unshift(breadcrumb);

      logger.info(`Pruned ${prunedCount} messages from conversation history`);
      this.lastPromptTokens = 0;
    }

    const result = systemMsg ? [systemMsg, ...messagesToKeep] : messagesToKeep;
    return { messages: result, pruned: prunedCount };
  }

  /**
   * Create a summary of old messages to preserve context while saving tokens.
   * Returns a condensed version of message history.
   */
  summarizeOldMessages(messages, summarizerFn) {
    const status = this.getStatus(messages);
    
    if (!status.shouldSummarize || messages.length <= MIN_KEEP_MESSAGES + 2) {
      return { messages, summarized: false };
    }
    
    // Split messages: old ones to summarize + recent ones to keep
    const systemMsg = messages[0]?.role === 'system' ? messages[0] : null;
    const conversationMsgs = systemMsg ? messages.slice(1) : messages;
    
    // Keep last N messages intact
    const keepCount = Math.max(MIN_KEEP_MESSAGES, Math.floor(conversationMsgs.length * 0.4));
    const toSummarize = conversationMsgs.slice(0, -keepCount);
    const toKeep = conversationMsgs.slice(-keepCount);
    
    if (toSummarize.length === 0) {
      return { messages, summarized: false };
    }
    
    // Build summary of old messages
    let summary = '### Previous conversation summary:\n';
    for (const msg of toSummarize) {
      if (msg.role === 'user') {
        summary += `- User asked: ${truncateText(msg.content, 100)}\n`;
      } else if (msg.role === 'assistant') {
        summary += `- Assistant: ${truncateText(msg.content, 100)}\n`;
      } else if (msg.role === 'tool') {
        summary += `- Tool result received\n`;
      }
    }
    
    const summaryMsg = {
      role: 'user',
      content: summary,
      _summarized: true,
    };
    
    const newMessages = systemMsg 
      ? [systemMsg, summaryMsg, ...toKeep]
      : [summaryMsg, ...toKeep];
    
    logger.info(`Summarized ${toSummarize.length} old messages to save context space`);
    this.lastPromptTokens = 0; // Reset to force re-estimation
    
    return { messages: newMessages, summarized: true };
  }

  /**
   * Update token counts from API response
   */
  updateFromAPI(promptTokens, completionTokens) {
    if (promptTokens) this.lastPromptTokens = promptTokens;
    if (completionTokens) this.lastCompletionTokens = completionTokens;
  }

  /**
   * Reset token tracking
   */
  reset() {
    this.lastPromptTokens = 0;
    this.lastCompletionTokens = 0;
  }

  /** Proxy to shared isContextOverflowError — preserves call site in agent.js */
  static isContextOverflowError(error) {
    return _isOverflow(error);
  }

  /**
   * Handle a context overflow error by pruning and retrying
   */
  handleOverflow(messages) {
    logger.warn('Context overflow detected - performing aggressive pruning');
    
    // Aggressive pruning - keep only very recent messages
    const pruned = this.pruneMessages(messages, { aggressive: true });
    
    // If still too long, summarize
    const status = this.getStatus(pruned);
    if (status.isCritical) {
      // Keep only system + last few messages
      const systemMsg = pruned[0]?.role === 'system' ? pruned[0] : null;
      const rest = systemMsg ? pruned.slice(1) : pruned;
      
      if (rest.length > MIN_KEEP_MESSAGES) {
        const minimal = rest.slice(-MIN_KEEP_MESSAGES);
        logger.warn(`Emergency context reduction: keeping only ${minimal.length} recent messages`);
        return systemMsg ? [systemMsg, ...minimal] : minimal;
      }
    }
    
    return pruned;
  }
}

/**
 * Truncate text to a maximum length
 */
function truncateText(text, maxLen) {
  if (!text) return '';
  const str = String(text);
  if (str.length <= maxLen) return str;
  return str.substring(0, maxLen - 3) + '...';
}

export default ContextManager;