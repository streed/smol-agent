/**
 * Provider factory — creates the appropriate LLM provider based on configuration.
 *
 * Provider selection:
 *   --provider ollama      → OllamaProvider (default, local, uses ollama npm)
 *   --provider ollama-api  → OllamaAPIProvider (direct HTTP API, no npm dependency)
 *   --provider openai      → OpenAICompatibleProvider (api.openai.com)
 *   --provider grok        → OpenAICompatibleProvider (api.x.ai)
 *   --provider groq        → OpenAICompatibleProvider (api.groq.com)
 *   --provider gemini      → OpenAICompatibleProvider (generativelanguage.googleapis.com)
 *   --provider anthropic   → AnthropicProvider (api.anthropic.com)
 *   --provider codex       → CodexCLIProvider (OpenAI Codex CLI)
 *   --provider <url>       → OpenAICompatibleProvider (custom base URL)
 *
 * Environment variables:
 *   SMOL_AGENT_PROVIDER     — default provider name
 *   OPENAI_API_KEY          — for openai provider
 *   XAI_API_KEY             — for grok provider
 *   GROQ_API_KEY            — for groq provider
 *   GEMINI_API_KEY          — for gemini provider
 *   ANTHROPIC_API_KEY       — for anthropic provider
 *
 * Key exports:
 *   - createProvider(options): Factory function returning configured provider
 *   - PROVIDER_PRESETS: Known provider configurations
 *   - getDefaultModel(providerName): Get default model for a provider
 *   - listProviders(): List known provider names
 *
 * Dependencies: ./ollama.js, ./openai-compatible.js, ./anthropic.js, ./base.js
 * Depended on by: jest.config.js, scripts/update-benchmark-readme.js, src/agent.js,
 *                  src/checkpoint.js, src/context-manager.js, src/cross-agent.js, src/index.js,
 *                  src/ollama.js, src/providers/openai-compatible.js, src/repo-map.js,
 *                  src/skills.js, src/token-estimator.js, src/tools/code_execution.js,
 *                  src/tools/file_tools.js, src/tools/git.js, src/tools/plan_tools.js,
 *                  src/ui/App.js, src/ui/diff.js, test/e2e/compare-results.js,
 *                  test/e2e/runner.js, test/unit/providers.test.js
 */
import { OllamaProvider, DEFAULT_MODEL as OLLAMA_DEFAULT_MODEL } from "./ollama.js";
import { OllamaAPIProvider } from "./ollama-api.js";
import { OpenAICompatibleProvider } from "./openai-compatible.js";
import { AnthropicProvider } from "./anthropic.js";
import { CodexCLIProvider } from "./codex-cli.js";
import type { BaseLLMProvider } from "./base.js";

export interface ProviderPreset {
  factory: (opts: ProviderOptions) => BaseLLMProvider;
  defaultModel: string;
  envKey: string | null;
}

export interface ProviderOptions {
  provider?: string;
  model?: string;
  host?: string;
  baseURL?: string;
  apiKey?: string | null;
  cwd?: string;
  programmaticToolCalling?: boolean;
  rateLimitConfig?: Partial<import("./base.js").RateLimitConfig>;
}

/** Known provider presets with their defaults. */
export const PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  ollama: {
    factory: (opts) => new OllamaProvider(opts) as BaseLLMProvider,
    defaultModel: OLLAMA_DEFAULT_MODEL,
    envKey: null, // Ollama doesn't need an API key
  },
  openai: {
    factory: (opts) =>
      new OpenAICompatibleProvider({
        ...opts,
        baseURL: opts.baseURL || "https://api.openai.com/v1",
        providerName: "openai",
      }) as BaseLLMProvider,
    defaultModel: "gpt-4o",
    envKey: "OPENAI_API_KEY",
  },
  grok: {
    factory: (opts) =>
      new OpenAICompatibleProvider({
        ...opts,
        baseURL: opts.baseURL || "https://api.x.ai/v1",
        providerName: "grok",
      }) as BaseLLMProvider,
    defaultModel: "grok-4-latest",
    envKey: "XAI_API_KEY",
  },
  groq: {
    factory: (opts) =>
      new OpenAICompatibleProvider({
        ...opts,
        baseURL: opts.baseURL || "https://api.groq.com/openai/v1",
        providerName: "groq",
        // Groq rate limits (Free tier): 30 RPM, 6K-30K TPM depending on model
        // Developer tier has higher limits. Adjust as needed.
        rateLimitConfig: opts.rateLimitConfig || {
          requestsPerMinute: 30,
          requestsPerSecond: 1,
          maxConcurrent: 1,
          rateLimitBackoffMs: 5000,
        },
      }) as BaseLLMProvider,
    defaultModel: "openai/gpt-oss-120b",
    envKey: "GROQ_API_KEY",
  },
  gemini: {
    factory: (opts) =>
      new OpenAICompatibleProvider({
        ...opts,
        baseURL: opts.baseURL || "https://generativelanguage.googleapis.com/v1beta/openai",
        providerName: "gemini",
      }) as BaseLLMProvider,
    defaultModel: "gemini-2.5-pro",
    envKey: "GEMINI_API_KEY",
  },
  "ollama-api": {
    factory: (opts) => new OllamaAPIProvider(opts) as BaseLLMProvider,
    defaultModel: OLLAMA_DEFAULT_MODEL,
    envKey: "OLLAMA_API_KEY", // Optional — only needed for authenticated proxies
  },
  anthropic: {
    factory: (opts) => new AnthropicProvider({ apiKey: opts.apiKey || "", ...opts }) as BaseLLMProvider,
    defaultModel: "claude-sonnet-4-20250514",
    envKey: "ANTHROPIC_API_KEY",
  },
  codex: {
    factory: (opts) =>
      new CodexCLIProvider({
        model: opts.model || "gpt-5.4",
        cwd: opts.cwd || process.cwd(),
      }) as BaseLLMProvider,
    defaultModel: "gpt-5.4",
    envKey: null,
  },
};

/**
 * Create an LLM provider from configuration.
 *
 * @param options - Provider configuration options
 * @param options.provider - Provider name or custom base URL
 * @param options.model - Model name
 * @param options.host - Host URL (Ollama) or base URL
 * @param options.apiKey - API key
 * @param options.cwd - Working directory for local providers
 * @param options.programmaticToolCalling - Enable programmatic tool calling
 * @returns Configured LLM provider instance
 */
export function createProvider({
  provider,
  model,
  host,
  apiKey,
  cwd,
  programmaticToolCalling,
}: ProviderOptions = {}): BaseLLMProvider {
  const rawProvider = provider || process.env.SMOL_AGENT_PROVIDER || "ollama";
  const providerName = rawProvider.toLowerCase();

  // Check if it's a known preset (case-insensitive)
  const preset = PROVIDER_PRESETS[providerName];
  if (preset) {
    const key =
      apiKey || (preset.envKey ? (process.env[preset.envKey] as string | undefined) : null);
    return preset.factory({
      model: model || preset.defaultModel,
      host,
      baseURL: host, // host doubles as baseURL for non-Ollama providers
      apiKey: key,
      cwd,
      programmaticToolCalling,
    });
  }

  // If provider looks like a URL, treat as custom OpenAI-compatible endpoint.
  // Use the original (non-lowercased) value to preserve URL path casing.
  if (rawProvider.startsWith("http://") || rawProvider.startsWith("https://")) {
    return new OpenAICompatibleProvider({
      baseURL: rawProvider,
      model: model || "default",
      apiKey: apiKey || process.env.OPENAI_API_KEY,
      providerName: "custom",
    }) as BaseLLMProvider;
  }

  // Unknown provider name
  throw new Error(
    `Unknown provider: "${rawProvider}". ` +
      `Available providers: ${Object.keys(PROVIDER_PRESETS).join(", ")}. ` +
      `Or pass a URL for a custom OpenAI-compatible endpoint.`
  );
}

/** Get default model for a provider. */
export function getDefaultModel(providerName?: string): string {
  const preset = PROVIDER_PRESETS[(providerName || "ollama").toLowerCase()];
  return preset?.defaultModel || OLLAMA_DEFAULT_MODEL;
}

/** List known provider names. */
export function listProviders(): string[] {
  return Object.keys(PROVIDER_PRESETS);
}