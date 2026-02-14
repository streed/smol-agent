import { Ollama } from "ollama";

const DEFAULT_MODEL = "qwen2.5-coder:7b";
const DEFAULT_MAX_TOKENS = 128000;

export function createClient(host) {
  const ollama = new Ollama({ host: host || "http://127.0.0.1:11434" });
  return ollama;
}

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
  
  return Math.ceil((totalChars + overhead) / 4); // Rough estimate: 4 chars = 1 token
}

export async function chat(ollama, model, messages, tools, signal, maxTokens = DEFAULT_MAX_TOKENS) {
  // Check if we need to adjust num_ctx based on message size
  const tokenCount = estimateTokenCount(messages);
  const numCtx = Math.max(tokenCount * 1.5, 16384, maxTokens);
  
  const response = await ollama.chat({
    model: model || DEFAULT_MODEL,
    messages,
    tools,
    stream: false,
    options: {
      num_ctx: Math.min(numCtx, maxTokens * 2) // Cap at 2x max tokens
    },
    signal
  });
  return response;
}

export function chatWithSummarization(ollama, model, messages, tools, signal, maxTokens = DEFAULT_MAX_TOKENS) {
  // Simple summarization logic - keep recent messages if context is too large
  const tokenCount = estimateTokenCount(messages);
  
  if (tokenCount > maxTokens * 0.95) {
    // Need to summarize
    // For now, just use the last N messages
    const recentCount = Math.max(5, Math.floor(messages.length * 0.3));
    messages = [messages[0], ...messages.slice(-(recentCount - 1))];
  }
  
  return chat(ollama, model, messages, tools, signal, maxTokens);
}

export { DEFAULT_MODEL };
