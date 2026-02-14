/**
 * Conversation summarizer - handles summarization of old messages
 */

const DEFAULT_SUMMARY_LENGTH = 150;
const MAX_TOKEN_ESTIMATE_MULTIPLIER = 0.95; // Summarize at 95% of max
const TOKEN_ESTIMATE_CHARS_PER_TOKEN = 4; // Rough estimate: 4 chars = 1 token

/**
 * Estimate token count from messages
 * @param {Array} messages - Array of message objects
 * @returns {number} - Estimated token count
 */
export function estimateTokenCount(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return 0;
  
  let totalChars = 0;
  for (const msg of messages) {
    if (msg.content) {
      totalChars += msg.content.length;
    }
    if (msg.name) {
      totalChars += msg.name.length;
    }
    if (msg.role) {
      totalChars += msg.role.length;
    }
  }
  
  // Add some overhead for JSON structure
  const overhead = messages.length * 50;
  
  return Math.ceil((totalChars + overhead) / TOKEN_ESTIMATE_CHARS_PER_TOKEN);
}

/**
 * Check if summarization should be triggered
 * @param {Array} messages - Current messages
 * @param {number} maxTokens - Maximum tokens allowed
 * @param {number} currentTokenCount - Current token count
 * @returns {boolean} - True if summarization needed
 */
export function shouldSummarize(messages, maxTokens, currentTokenCount) {
  if (!messages || messages.length === 0) return false;
  
  // Summarize if we're at 95% capacity
  return currentTokenCount >= maxTokens * MAX_TOKEN_ESTIMATE_MULTIPLIER;
}

/**
 * Generate a summary of the conversation
 * @param {Array} messages - Messages to summarize
 * @param {number} summaryLength - Target summary length in words
 * @returns {string} - Summary text
 */
export async function summarizeConversation(messages, summaryLength = DEFAULT_SUMMARY_LENGTH) {
  if (!messages || messages.length === 0) {
    return 'No conversation history.';
  }
  
  // Build conversation text for summarization
  const conversationText = messages.map(msg => {
    const role = msg.role?.toUpperCase() || 'UNKNOWN';
    return `${role}: ${msg.content}`;
  }).join('\n\n');
  
  // We'll use a simple summary approach for now
  // In a real implementation, this would call an LLM
  // For now, we'll use the first message and last message as a "summary"
  
  if (messages.length <= 3) {
    // Not enough messages to summarize
    return 'Conversation started.';
  }
  
  // Create a summary placeholder
  // In production, this would make an LLM call like:
  // "Summarize the following conversation in about [summaryLength] words:\n\n[conversation]"
  
  const firstMsg = messages[0];
  const lastMsg = messages[messages.length - 1];
  
  return `Previous conversation about ${firstMsg.content.substring(0, 50)}... continues through ${messages.length - 2} intermediate messages to ${lastMsg.content.substring(0, 50)}...`;
}

/**
 * Create summarized messages by replacing old messages with a summary
 * @param {Array} messages - Original messages
 * @param {string} summary - Summary text
 * @param {number} keepRecent - Number of recent messages to keep
 * @returns {Array} - New messages array with summary
 */
export function createSummarizedMessages(messages, summary, keepRecent = 3) {
  if (!messages || messages.length <= keepRecent + 1) {
    return messages; // Not enough messages to summarize
  }
  
  // Keep the system prompt (first message) and recent messages
  const systemMsg = messages[0];
  const recentMsgs = messages.slice(-keepRecent);
  
  return [
    systemMsg,
    {
      role: 'user',
      content: `[Previous conversation summarized: ${summary}]`,
    },
    ...recentMsgs,
  ];
}

/**
 * Simple summarization that just compresses messages
 * @param {Array} messages - Messages to summarize
 * @param {number} targetCount - Target number of messages after summarization
 * @returns {Array} - Summarized messages
 */
export function simpleSummarize(messages, targetCount = 5) {
  if (!messages || messages.length <= targetCount) {
    return messages;
  }
  
  // Keep system prompt and recent messages
  const systemMsg = messages[0];
  const recentMsgs = messages.slice(-(targetCount - 1));
  
  return [systemMsg, ...recentMsgs];
}

export default {
  estimateTokenCount,
  shouldSummarize,
  summarizeConversation,
  createSummarizedMessages,
  simpleSummarize,
};
