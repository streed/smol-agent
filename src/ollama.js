/**
 * Backward-compatible re-exports from the new provider system.
 *
 * This file is kept so that any external code or tests importing from
 * "./ollama.js" continue to work.  New code should import from
 * "./providers/index.js" or use the provider abstraction directly.
 *
 * @deprecated Use providers/ollama.js or providers/index.js instead.
 */

import { OllamaProvider, DEFAULT_MODEL } from "./providers/ollama.js";

export { DEFAULT_MODEL };

/** Create an Ollama client (returns the raw Ollama SDK instance). */
export function createClient(host) {
  const provider = new OllamaProvider({ host });
  return provider.client;
}

/** Rough token estimate — only used for pre-call context-size heuristics. */
export function estimateTokenCount(messages) {
  const provider = new OllamaProvider();
  return provider.estimateTokenCount(messages);
}

/**
 * Streaming chat — creates a temporary provider and delegates.
 * @deprecated Use an OllamaProvider instance instead.
 */
export async function* chatStream(client, model, messages, tools, signal, maxTokens, onRetry) {
  const provider = new OllamaProvider({ model });
  provider.client = client;
  yield* provider.chatStream(messages, tools, signal, maxTokens, onRetry);
}

/**
 * Non-streaming chat.
 * @deprecated Use an OllamaProvider instance instead.
 */
export async function chatWithRetry(client, model, messages, tools, signal, maxTokens, onRetry) {
  const provider = new OllamaProvider({ model });
  provider.client = client;
  return provider.chatWithRetry(messages, tools, signal, maxTokens, onRetry);
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
