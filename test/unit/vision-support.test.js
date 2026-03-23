/**
 * Tests for provider vision support detection.
 */

import { describe, it, expect } from "@jest/globals";
import { OllamaProvider } from "../../src/providers/ollama.js";
import { OpenAICompatibleProvider } from "../../src/providers/openai-compatible.js";
import { AnthropicProvider } from "../../src/providers/anthropic.js";
import { BaseLLMProvider } from "../../src/providers/base.js";

describe("supportsVision", () => {
  describe("BaseLLMProvider", () => {
    it("returns false by default", () => {
      const provider = new BaseLLMProvider();
      expect(provider.supportsVision()).toBe(false);
    });
  });

  describe("OllamaProvider", () => {
    it("returns true for llava models", () => {
      const provider = new OllamaProvider({ model: "llava" });
      expect(provider.supportsVision()).toBe(true);
    });

    it("returns true for bakllava models", () => {
      const provider = new OllamaProvider({ model: "bakllava:latest" });
      expect(provider.supportsVision()).toBe(true);
    });

    it("returns true for moondream models", () => {
      const provider = new OllamaProvider({ model: "moondream" });
      expect(provider.supportsVision()).toBe(true);
    });

    it("returns true for pixtral models", () => {
      const provider = new OllamaProvider({ model: "pixtral" });
      expect(provider.supportsVision()).toBe(true);
    });

    it("returns true for gemma3 models", () => {
      const provider = new OllamaProvider({ model: "gemma3:12b" });
      expect(provider.supportsVision()).toBe(true);
    });

    it("returns false for non-vision models", () => {
      const provider = new OllamaProvider({ model: "llama3.2" });
      expect(provider.supportsVision()).toBe(false);
    });

    it("returns false for codellama", () => {
      const provider = new OllamaProvider({ model: "codellama:7b" });
      expect(provider.supportsVision()).toBe(false);
    });
  });

  describe("OpenAICompatibleProvider", () => {
    it("returns true for gpt-4o models", () => {
      const provider = new OpenAICompatibleProvider({ model: "gpt-4o", apiKey: "test" });
      expect(provider.supportsVision()).toBe(true);
    });

    it("returns true for gpt-4-turbo models", () => {
      const provider = new OpenAICompatibleProvider({ model: "gpt-4-turbo", apiKey: "test" });
      expect(provider.supportsVision()).toBe(true);
    });

    it("returns false for gpt-3.5 models", () => {
      const provider = new OpenAICompatibleProvider({ model: "gpt-3.5-turbo", apiKey: "test" });
      expect(provider.supportsVision()).toBe(false);
    });

    it("returns true for grok models (all have vision)", () => {
      const provider = new OpenAICompatibleProvider({
        model: "grok-4-latest",
        apiKey: "test",
        providerName: "grok",
      });
      expect(provider.supportsVision()).toBe(true);
    });

    it("returns true for gemini models", () => {
      const provider = new OpenAICompatibleProvider({
        model: "gemini-2.0-flash",
        apiKey: "test",
        providerName: "gemini",
      });
      expect(provider.supportsVision()).toBe(true);
    });
  });

  describe("AnthropicProvider", () => {
    it("returns true for claude-3-opus", () => {
      const provider = new AnthropicProvider({ model: "claude-3-opus", apiKey: "test" });
      expect(provider.supportsVision()).toBe(true);
    });

    it("returns true for claude-3-sonnet", () => {
      const provider = new AnthropicProvider({ model: "claude-3-5-sonnet", apiKey: "test" });
      expect(provider.supportsVision()).toBe(true);
    });

    it("returns true for claude-3-haiku", () => {
      const provider = new AnthropicProvider({ model: "claude-3-haiku", apiKey: "test" });
      expect(provider.supportsVision()).toBe(true);
    });

    it("returns false for claude-2 models", () => {
      const provider = new AnthropicProvider({ model: "claude-2", apiKey: "test" });
      expect(provider.supportsVision()).toBe(false);
    });
  });
});