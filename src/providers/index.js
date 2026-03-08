/**
 * Provider factory — creates the appropriate LLM provider based on configuration.
 *
 * Provider selection:
 *   --provider ollama    → OllamaProvider (default, local)
 *   --provider openai    → OpenAICompatibleProvider (api.openai.com)
 *   --provider grok      → OpenAICompatibleProvider (api.x.ai)
 *   --provider anthropic → AnthropicProvider (api.anthropic.com)
 *   --provider <url>     → OpenAICompatibleProvider (custom base URL)
 *
 * Environment variables:
 *   SMOL_AGENT_PROVIDER     — default provider name
 *   OPENAI_API_KEY          — for openai provider
 *   XAI_API_KEY             — for grok provider
 *   ANTHROPIC_API_KEY       — for anthropic provider
 */

import { OllamaProvider, DEFAULT_MODEL as OLLAMA_DEFAULT_MODEL } from "./ollama.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { AnthropicProvider } from "./anthropic.js";

/** Known provider presets with their defaults. */
const PROVIDER_PRESETS = {
  ollama: {
    factory: (opts) => new OllamaProvider(opts),
    defaultModel: OLLAMA_DEFAULT_MODEL,
    envKey: null, // Ollama doesn't need an API key
  },
  openai: {
    factory: (opts) => new OpenAICompatibleProvider({
      ...opts,
      baseURL: opts.baseURL || "https://api.openai.com/v1",
      providerName: "openai",
    }),
    defaultModel: "gpt-4o",
    envKey: "OPENAI_API_KEY",
  },
  grok: {
    factory: (opts) => new OpenAICompatibleProvider({
      ...opts,
      baseURL: opts.baseURL || "https://api.x.ai/v1",
      providerName: "grok",
    }),
    defaultModel: "grok-3",
    envKey: "XAI_API_KEY",
  },
  anthropic: {
    factory: (opts) => new AnthropicProvider(opts),
    defaultModel: "claude-sonnet-4-20250514",
    envKey: "ANTHROPIC_API_KEY",
  },
};

/**
 * Create an LLM provider from configuration.
 *
 * @param {object} options
 * @param {string} [options.provider]  - Provider name or custom base URL
 * @param {string} [options.model]     - Model name
 * @param {string} [options.host]      - Host URL (Ollama) or base URL
 * @param {string} [options.apiKey]    - API key
 * @returns {import('./base.js').BaseLLMProvider}
 */
export function createProvider({ provider, model, host, apiKey } = {}) {
  const providerName = (provider || process.env.SMOL_AGENT_PROVIDER || "ollama").toLowerCase();

  // Check if it's a known preset
  const preset = PROVIDER_PRESETS[providerName];
  if (preset) {
    const key = apiKey || (preset.envKey ? process.env[preset.envKey] : null);
    return preset.factory({
      model: model || preset.defaultModel,
      host,
      baseURL: host, // host doubles as baseURL for non-Ollama providers
      apiKey: key,
    });
  }

  // If provider looks like a URL, treat as custom OpenAI-compatible endpoint
  if (providerName.startsWith("http://") || providerName.startsWith("https://")) {
    return new OpenAICompatibleProvider({
      baseURL: providerName,
      model: model || "default",
      apiKey: apiKey || process.env.OPENAI_API_KEY,
      providerName: "custom",
    });
  }

  // Unknown provider name
  throw new Error(
    `Unknown provider: "${providerName}". ` +
    `Available providers: ${Object.keys(PROVIDER_PRESETS).join(", ")}. ` +
    `Or pass a URL for a custom OpenAI-compatible endpoint.`
  );
}

/** Get default model for a provider. */
export function getDefaultModel(providerName) {
  const preset = PROVIDER_PRESETS[(providerName || "ollama").toLowerCase()];
  return preset?.defaultModel || OLLAMA_DEFAULT_MODEL;
}

/** List known provider names. */
export function listProviders() {
  return Object.keys(PROVIDER_PRESETS);
}

export { PROVIDER_PRESETS };
