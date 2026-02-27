/**
 * Conversation utilities - token estimation
 */

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
 * Get detailed token breakdown for debugging/display
 * @param {Array} messages - Array of message objects
 * @returns {Object} - Token breakdown with role details
 */
export function getTokenBreakdown(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return { total: 0, byRole: {}, byMessage: [] };
  }

  const byRole = {};
  const byMessage = [];
  let totalChars = 0;

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    let msgChars = 0;
    
    if (msg.content) {
      msgChars += msg.content.length;
    }
    if (msg.name) {
      msgChars += msg.name.length;
    }
    if (msg.role) {
      msgChars += msg.role.length;
    }

    const msgTokens = Math.ceil((msgChars + 50) / TOKEN_ESTIMATE_CHARS_PER_TOKEN);
    totalChars += msgChars;

    byRole[msg.role] = (byRole[msg.role] || 0) + msgTokens;
    byMessage.push({
      index: i,
      role: msg.role,
      tokens: msgTokens,
      preview: msg.content ? msg.content.substring(0, 50).replace(/\n/g, ' ') + '...' : '',
    });
  }

  const overhead = messages.length * 50;
  const total = Math.ceil((totalChars + overhead) / TOKEN_ESTIMATE_CHARS_PER_TOKEN);

  return { total, byRole, byMessage };
}

export default {
  estimateTokenCount,
  getTokenBreakdown,
};