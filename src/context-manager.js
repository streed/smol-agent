/**
 * Context management for conversation history.
 * 
 * Based on research from Aider, Pydantic AI, and other coding agents:
 * - Proactive pruning before hitting limits
 * - LLM-based intelligent summarization
 * - Prioritizes recent context while preserving key information
 * - Handles tool results specially (they can be large)
 * 
 * Key strategies:
 * 1. At 60% capacity: Start summarizing old messages
 * 2. At 70% capacity: Prune tool results and old messages
 * 3. At 85% capacity: Aggressive pruning
 * 4. On overflow: Emergency reduction
 */

import { logger } from './logger.js';
import { isContextOverflowError as _isOverflow } from './errors.js';
import { summarizeMessagesWithLLM, selectMessagesToSummarize } from './context-summarizer.js';
import { estimateMessageTokens, estimateTokens, estimateTotalTokens as estimateTokensTotal } from './token-estimator.js';

// Configuration
const DEFAULT_MAX_TOKENS = 128000;
const PRUNE_THRESHOLD = 0.70;      // Start pruning at 70% capacity
const CRITICAL_THRESHOLD = 0.85;   // Aggressive pruning at 85%
const MIN_KEEP_MESSAGES = 6;      // Always keep last N user/assistant pairs
const MAX_TOOL_RESULT_SIZE = 15000; // Max chars for tool results (prevents context bloat)
const SUMMARY_THRESHOLD = 0.55;   // Start summarizing at 55% (earlier than before)
const SUMMARY_TARGET_RATIO = 0.35; // Target 35% of context for summarized portion

/**
 * Get context management configuration based on model size.
 * Larger models can handle more context and benefit from more aggressive summarization.
 */
export function getContextConfig(modelName) {
  const isLargeModel = modelName && (
    modelName.includes('70b') || 
    modelName.includes('72b') || 
    modelName.includes('32b')
  );
  
  return {
    // Larger models can use more context before summarizing
    summaryThreshold: isLargeModel ? 0.55 : 0.50,
    // Same pruning threshold for all
    pruneThreshold: PRUNE_THRESHOLD,
    // Critical threshold
    criticalThreshold: CRITICAL_THRESHOLD,
    // Larger models can keep more messages when pruning
    minKeepMessages: isLargeModel ? 8 : MIN_KEEP_MESSAGES,
    // Enable LLM summarization for models with all tools
    enableLLMSummarization: isLargeModel,
  };
}

// Re-export token estimator functions for convenience
export { estimateTokens, estimateMessageTokens };

/**
 * Calculate the importance score for a message (higher = more important to keep).
 * Based on research from coding agents:
 * - User messages with new requests are high priority
 * - Error messages are high priority (contain critical context)
 * - System messages are essential
 * - Tool results are lower priority (can often be re-derived)
 * - Summarized messages are lowest priority
 */
function calculateMessageImportance(msg, index, messages) {
  let score = 50; // Base score
  
  // System messages are essential
  if (msg.role === 'system') {
    return 1000;
  }
  
  // Summarized messages are lowest priority (already compressed)
  if (msg._summarized) {
    return 10;
  }
  
  // User messages are high priority (contain user intent)
  if (msg.role === 'user') {
    score += 30;
    // Recent user messages are even more important
    if (index >= messages.length - 3) {
      score += 20;
    }
  }
  
  // Assistant messages with tool calls contain important context
  if (msg.role === 'assistant') {
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      score += 15;
    }
    // Recent assistant messages are more important
    if (index >= messages.length - 4) {
      score += 25;
    }
  }
  
  // Tool results can be large but often contain critical info
  if (msg.role === 'tool') {
    score += 5; // Base score for tool results
    
    // Error results are higher priority
    try {
      const parsed = JSON.parse(msg.content);
      if (parsed?.error) {
        score += 25; // Errors are important context
      }
    } catch {
      // Not JSON, could be string output
    }
    
    // Very large tool results get deprioritized
    if (msg.content && msg.content.length > 5000) {
      score -= 20;
    }
  }
  
  // Recency bonus (exponential decay)
  const recencyBonus = Math.floor(10 * Math.exp(-0.1 * (messages.length - index)));
  score += recencyBonus;
  
  return score;
}

/**
 * Estimate total tokens in messages array
 * @deprecated Use estimateTotalTokens from token-estimator.js
 */
export function estimateTotalTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  return estimateTokensTotal(messages);
}

/**
 * Context Manager class
 */
export class ContextManager {
  constructor(maxTokens = DEFAULT_MAX_TOKENS) {
    this.maxTokens = maxTokens;
    this.lastPromptTokens = 0; // Actual count from API when available
    this.lastCompletionTokens = 0;
    this._messageCountAtLastUpdate = 0; // Track staleness of lastPromptTokens
    this.ollamaHost = null; // Host URL for LLM-based summarization
    this.llmModel = null;
  }

  /**
   * Set the LLM client for intelligent summarization
   */
  setLLMClient(host, model) {
    this.ollamaHost = host;
    this.llmModel = model;
  }

  /**
   * Get current token usage (prefer API counts over estimates).
   * Falls back to estimation if the cached count is stale (messages changed since last API update).
   */
  getUsage(messages) {
    const messageCount = Array.isArray(messages) ? messages.length : 0;
    const isStale = messageCount !== this._messageCountAtLastUpdate;
    const used = (this.lastPromptTokens && !isStale) ? this.lastPromptTokens : estimateTotalTokens(messages);
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
   * Truncate large tool results to prevent context bloat.
   * Preserves error messages and structured data better.
   * @param {*} result - Tool result to truncate
   * @param {number} [contextUsageRatio=0] - Current context usage ratio (0-1). Higher values shrink the ceiling.
   */
  truncateToolResult(result, contextUsageRatio = 0) {
    if (!result) return result;

    // Adaptive ceiling: at 0% usage → 15000 chars, at 80%+ → 3000 chars
    const effectiveMax = Math.floor(MAX_TOOL_RESULT_SIZE * Math.max(0.2, 1 - contextUsageRatio));

    const str = typeof result === 'string' ? result : JSON.stringify(result);

    if (str.length <= effectiveMax) {
      return result;
    }

    // For error results, try to preserve the full error
    if (typeof result === 'object' && result?.error) {
      const errorStr = JSON.stringify({ error: result.error });
      if (errorStr.length < effectiveMax) {
        return { error: result.error, truncated: true };
      }
    }

    // For file content, preserve beginning and end (scale keepLines with ceiling)
    const lines = str.split('\n');
    const keepLines = Math.max(10, Math.floor(50 * Math.max(0.2, 1 - contextUsageRatio)));
    if (lines.length > keepLines * 2) {
      const kept = [
        ...lines.slice(0, keepLines),
        `... [${lines.length - keepLines * 2} lines omitted] ...`,
        ...lines.slice(-keepLines)
      ];
      const truncated = kept.join('\n');
      const indicator = '\n\n[... output truncated to save context space ...]';

      logger.warn(`Truncated large tool result (${str.length} -> ${truncated.length} chars, ${lines.length} -> ${kept.length} lines)`);

      return typeof result === 'string'
        ? truncated + indicator
        : { truncated: true, content: truncated + indicator };
    }

    // Standard truncation
    const truncated = str.substring(0, effectiveMax);
    const indicator = '\n\n[... output truncated to save context space ...]';

    logger.warn(`Truncated large tool result (${str.length} -> ${truncated.length} chars)`);

    return typeof result === 'string'
      ? truncated + indicator
      : { truncated: true, content: truncated + indicator };
  }

  /**
   * Progressively compress old tool results AND assistant messages in-place to save tokens.
   * Cheap to call every iteration — only mutates messages older than a threshold.
   *
   * Tool result thresholds (age = messages.length - index):
   *   > 40: truncate to 200 chars
   *   > 20: truncate to 500 chars
   *   > 10: truncate to 2000 chars
   *
   * Assistant message thresholds:
   *   > 40: truncate to 200 chars
   *   > 20: truncate to 500 chars
   *
   * Never compresses: error tool results, assistant messages with tool_calls, user/system messages.
   */
  compressOldMessages(messages) {
    const len = messages.length;
    let compressed = 0;

    for (let i = 0; i < len; i++) {
      const msg = messages[i];
      if (!msg.content) continue;

      const age = len - i;

      if (msg.role === 'tool') {
        // Never compress error results
        try {
          const parsed = JSON.parse(msg.content);
          if (parsed?.error) continue;
        } catch { /* not JSON, proceed */ }

        let maxChars;
        if (age > 40) maxChars = 200;
        else if (age > 20) maxChars = 500;
        else if (age > 10) maxChars = 2000;
        else continue; // too recent

        if (msg.content.length > maxChars) {
          msg.content = msg.content.substring(0, maxChars) + '\n[... compressed — old tool result ...]';
          compressed++;
        }
      } else if (msg.role === 'assistant') {
        // Never compress assistant messages with tool_calls (structural)
        if (msg.tool_calls) continue;

        let maxChars;
        if (age > 40) maxChars = 200;
        else if (age > 20) maxChars = 500;
        else continue; // too recent for assistant messages

        if (msg.content.length > maxChars) {
          msg.content = msg.content.substring(0, maxChars) + '\n[... compressed — old assistant message ...]';
          compressed++;
        }
      }
      // Never compress user or system messages
    }

    if (compressed > 0) {
      logger.info(`Compressed ${compressed} old messages`);
    }
    return compressed;
  }

  /** @deprecated Use compressOldMessages instead */
  compressOldToolResults(messages) {
    return this.compressOldMessages(messages);
  }

  /**
   * Prune conversation history to free up context space.
   * Uses importance scoring to keep the most valuable messages.
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

    // Subtract system prompt size from budget — it's always present and can't be pruned
    const systemTokens = systemMsg ? estimateMessageTokens(systemMsg) : 0;
    const availableTokens = this.maxTokens - systemTokens;

    // Calculate how many messages to keep based on current usage
    const overageRatio = status.usage.percentage / 100;
    const targetPercentage = aggressive || overageRatio > 1.5 ? 0.30 : 0.50;
    const targetTokens = Math.floor(availableTokens * targetPercentage);

    // Score messages by importance
    const scoredMessages = restMessages.map((msg, index) => ({
      msg,
      index,
      tokens: estimateMessageTokens(msg),
      importance: calculateMessageImportance(msg, index, restMessages),
    }));

    // Sort by importance (descending), then by recency for tie-breaking
    scoredMessages.sort((a, b) => {
      if (b.importance !== a.importance) return b.importance - a.importance;
      return b.index - a.index; // More recent wins
    });

    // Select messages to keep, prioritizing by importance score
    let keptTokens = 0;
    const messagesToKeep = [];
    const keptIndices = new Set();

    for (const scored of scoredMessages) {
      if (keptTokens + scored.tokens > targetTokens && messagesToKeep.length >= MIN_KEEP_MESSAGES) {
        break;
      }
      messagesToKeep.push(scored);
      keptIndices.add(scored.index);
      keptTokens += scored.tokens;
    }

    // Re-sort by original index to maintain conversation order
    messagesToKeep.sort((a, b) => a.index - b.index);

    // Extract messages in order
    const keptMessages = messagesToKeep.map(s => s.msg);

    const prunedCount = restMessages.length - messagesToKeep.length;
    if (prunedCount > 0) {
      // Build a breadcrumb summarising what was pruned
      const pruned = restMessages.filter((_, i) => !keptIndices.has(i));
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

      keptMessages.unshift(breadcrumb);

      logger.info(`Pruned ${prunedCount} messages from conversation history (importance-based)`);
      this.lastPromptTokens = 0;
    }

    const result = sanitizeMessageOrder(systemMsg ? [systemMsg, ...keptMessages] : keptMessages);
    return { messages: result, pruned: prunedCount };
  }

  /**
   * Create a summary of old messages to preserve context while saving tokens.
   * Uses LLM-based summarization if available, falls back to simple extraction.
   */
  async summarizeOldMessages(messages) {
    const status = this.getStatus(messages);
    
    if (!status.shouldSummarize || messages.length <= MIN_KEEP_MESSAGES + 2) {
      return { messages, summarized: false };
    }
    
    const targetTokens = Math.floor(this.maxTokens * SUMMARY_TARGET_RATIO);
    const { toSummarize, toKeep, systemMsg } = selectMessagesToSummarize(
      messages,
      targetTokens,
      estimateMessageTokens
    );
    
    if (toSummarize.length === 0) {
      return { messages, summarized: false };
    }
    
    let summaryContent;
    
    // Try LLM-based summarization if client is available
    if (this.ollamaHost && this.llmModel) {
      try {
        summaryContent = await summarizeMessagesWithLLM(toSummarize, this.ollamaHost, this.llmModel);
        logger.info(`LLM summarized ${toSummarize.length} old messages`);
      } catch (error) {
        logger.warn(`LLM summarization failed, using fallback: ${error.message}`);
        summaryContent = this._createSimpleSummary(toSummarize);
      }
    } else {
      // Fallback to simple summarization
      summaryContent = this._createSimpleSummary(toSummarize);
      logger.info(`Simple summarized ${toSummarize.length} old messages`);
    }
    
    const summaryMsg = {
      role: 'user',
      content: summaryContent,
      _summarized: true,
    };
    
    const newMessages = sanitizeMessageOrder(systemMsg
      ? [systemMsg, summaryMsg, ...toKeep]
      : [summaryMsg, ...toKeep]);

    this.lastPromptTokens = 0; // Reset to force re-estimation

    return { messages: newMessages, summarized: true };
  }
  
  /**
   * Create a simple summary without LLM (fast, less context-aware).
   */
  _createSimpleSummary(messages) {
    const topics = [];
    const files = new Set();
    const tools = new Set();
    const decisions = [];

    for (const msg of messages) {
      // Extract file references
      const fileMatches = msg.content?.match(/\b[\w/.-]+\.(js|ts|py|json|md|txt|yml|yaml|go|rs|java)\b/g) || [];
      fileMatches.forEach(f => files.add(f));

      // Track tools used
      if (msg.tool_calls) {
        msg.tool_calls.forEach(tc => {
          if (tc.function?.name) tools.add(tc.function.name);
        });
      }
      
      // Track tool results
      if (msg.role === 'tool' && msg.content) {
        try {
          const parsed = JSON.parse(msg.content);
          if (parsed.error) tools.add(`error:${parsed.error.substring(0, 30)}`);
        } catch {
          // Not JSON
        }
      }

      // Get user topics (first 80 chars of user messages)
      if (msg.role === 'user' && msg.content && !msg._summarized) {
        const topic = msg.content.substring(0, 80).replace(/\n/g, ' ');
        if (topic.length > 10) topics.push(topic);
      }
      
      // Track assistant decisions
      if (msg.role === 'assistant' && msg.content) {
        const decisionMatch = msg.content.match(/(?:created|modified|updated|deleted|added)\s+([\w/.-]+)/i);
        if (decisionMatch) decisions.push(decisionMatch[0]);
      }
    }

    const parts = [`${messages.length} earlier messages compacted.`];
    
    if (files.size > 0) {
      const fileList = [...files].slice(0, 6).join(', ');
      parts.push(`Files: ${fileList}${files.size > 6 ? '...' : ''}.`);
    }
    
    if (tools.size > 0) {
      parts.push(`Tools: ${[...tools].slice(0, 5).join(', ')}.`);
    }
    
    if (decisions.length > 0) {
      parts.push(`Actions: ${decisions.slice(0, 3).join('; ')}.`);
    }
    
    if (topics.length > 0) {
      parts.push(`Topics: "${topics[topics.length - 1]}"`);
    }

    return `[Context compacted: ${parts.join(' ')}]`;
  }

  /**
   * Update token counts from API response.
   * @param {number} promptTokens
   * @param {number} completionTokens
   * @param {number} [messageCount] — current messages.length, used for staleness detection
   */
  updateFromAPI(promptTokens, completionTokens, messageCount) {
    if (promptTokens) this.lastPromptTokens = promptTokens;
    if (completionTokens) this.lastCompletionTokens = completionTokens;
    if (messageCount != null) this._messageCountAtLastUpdate = messageCount;
  }

  /**
   * Reset token tracking
   */
  reset() {
    this.lastPromptTokens = 0;
    this.lastCompletionTokens = 0;
    this._messageCountAtLastUpdate = 0;
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
    const { messages: prunedMessages } = this.pruneMessages(messages, { aggressive: true });

    // If still too long, do emergency reduction
    const status = this.getStatus(prunedMessages);
    if (status.isCritical) {
      const systemMsg = prunedMessages[0]?.role === 'system' ? prunedMessages[0] : null;
      const rest = systemMsg ? prunedMessages.slice(1) : prunedMessages;

      if (rest.length > MIN_KEEP_MESSAGES) {
        const minimal = rest.slice(-MIN_KEEP_MESSAGES);
        logger.warn(`Emergency context reduction: keeping only ${minimal.length} recent messages`);
        return sanitizeMessageOrder(systemMsg ? [systemMsg, ...minimal] : minimal);
      }
    }

    return sanitizeMessageOrder(prunedMessages);
  }
}

/**
 * Sanitize message ordering to ensure 'tool' messages always follow an
 * 'assistant' message with tool_calls.  Some LLM APIs (Ollama, OpenAI)
 * reject sequences like user→tool.  This can happen after importance-based
 * pruning or emergency slicing removes the assistant message that originally
 * triggered the tool calls.
 *
 * Strategy: walk the array and drop any 'tool' message that is not immediately
 * preceded by either another 'tool' message or an 'assistant' message carrying
 * tool_calls.  This is the cheapest fix that preserves valid sequences.
 */
function sanitizeMessageOrder(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return messages;

  const result = [messages[0]]; // always keep first (system)

  for (let i = 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'tool') {
      const prev = result[result.length - 1];
      // Valid predecessors: assistant with tool_calls, or another tool message
      if (prev && (prev.role === 'tool' || (prev.role === 'assistant' && prev.tool_calls))) {
        result.push(msg);
      } else {
        logger.debug(`Dropped orphaned tool message at index ${i} (preceded by ${prev?.role})`);
      }
    } else {
      result.push(msg);
    }
  }

  return result;
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