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
import type { ChatMessage, ToolDefinition, StreamEvent, OnRetryCallback } from "./providers/base.js";

export { DEFAULT_MODEL, OllamaProvider };
export type { ChatMessage, ToolDefinition, StreamEvent, OnRetryCallback };

/** Create an Ollama client (returns the raw Ollama SDK instance). */
export function createClient(host: string): unknown {
  const provider = new OllamaProvider({ host });
  return provider.client;
}

/** Rough token estimate — only used for pre-call context-size heuristics. */
export function estimateTokenCount(messages: ChatMessage[]): number {
  const provider = new OllamaProvider();
  return provider.estimateTokenCount(messages);
}

/**
 * Streaming chat — creates a temporary provider and delegates.
 * @deprecated Use an OllamaProvider instance instead.
 */
export async function* chatStream(
  client: unknown,
  model: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
  maxTokens?: number,
  onRetry?: OnRetryCallback
): AsyncGenerator<StreamEvent> {
  const provider = new OllamaProvider({ model });
  provider.client = client as OllamaProvider["client"];
  yield* provider.chatStream(messages, tools, signal, maxTokens, onRetry);
}

/**
 * Non-streaming chat.
 * @deprecated Use an OllamaProvider instance instead.
 */
export async function chatWithRetry(
  client: unknown,
  model: string,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  signal?: AbortSignal,
  maxTokens?: number,
  onRetry?: OnRetryCallback
): Promise<{ message: { content?: string; tool_calls?: Array<{ function: { name: string; arguments: string | Record<string, unknown> } }> } }> {
  const provider = new OllamaProvider({ model });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (provider as any).client = client;
  const response = await provider.chatWithRetry(messages, tools, signal, maxTokens, onRetry);
  return {
    message: {
      content: response.message?.content,
      tool_calls: response.message?.tool_calls,
    },
  };
}

/** List available models from Ollama. */
export async function listModels(client: unknown): Promise<Array<{ name: string }>> {
  try {
    // Cast to ollama client type
    const ollamaClient = client as { list: () => Promise<{ models?: Array<{ name?: string; model?: string }> }> };
    const response = await ollamaClient.list();
    return (response.models || []).map(m => ({ name: m.name || m.model || "" }));
  } catch {
    return [];
  }
}