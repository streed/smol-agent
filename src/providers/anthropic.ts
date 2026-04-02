/**
 * Anthropic (Claude) LLM provider.
 *
 * Uses the Anthropic Messages API with tool use support.
 * No SDK dependency — uses native fetch.
 *
 * API docs: https://docs.anthropic.com/en/docs/build-with-claude/tool-use
 *
 * Key differences from OpenAI format:
 *   - System prompt is a top-level parameter, not a message
 *   - Tool definitions use input_schema instead of parameters
 *   - Tool results use tool_result content blocks
 *   - Streaming uses server-sent events with different event types
 *
 * Key exports:
 *   - AnthropicProvider class: Main provider implementation
 *   - Methods: chatStream(), chatWithRetry(), formatTools()
 *
 * Dependencies: ./base.js, ./errors.js
 * Depended on by: src/agent.js, src/index.js, src/providers/index.js,
 *                  src/providers/openai-compatible.js, test/unit/providers.test.js,
 *                  test/unit/vision-support.test.js
 */

import { BaseLLMProvider, MAX_RETRIES, type ChatMessage, type ToolDefinition, type StreamEvent, type OnRetryCallback, type ChatResponse } from "./base.js";
import { formatAPIError } from "./errors.js";

const DEFAULT_MAX_TOKENS = 8192; // Anthropic max output tokens

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
  allowed_callers?: string[];
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  caller?: string;
  content?: {
    stdout?: string;
    stderr?: string;
  };
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

interface ParsedResponse {
  text: string;
  toolCalls: Array<{ id?: string; function: { name: string; arguments: Record<string, unknown> }; caller?: string }>;
  serverToolUses: Array<{ id?: string; name: string; input: Record<string, unknown> }>;
  codeExecutionResults: AnthropicContentBlock[];
}

interface ConvertedMessages {
  system: string;
  messages: AnthropicMessage[];
}

export class AnthropicProvider extends BaseLLMProvider {
  apiKey: string | null;
  baseURL: string;
  programmaticToolCalling: boolean;
  _containerId: string | null;

  /** Models that support Anthropic's server-side programmatic tool calling. */
  static PROGRAMMATIC_MODELS = new Set([
    "claude-opus-4-6", "claude-sonnet-4-6",
    "claude-sonnet-4-5-20250929", "claude-opus-4-5-20251101",
  ]);

  constructor({ apiKey, model, baseURL, rateLimitConfig, programmaticToolCalling }: {
    apiKey?: string;
    model?: string;
    baseURL?: string;
    rateLimitConfig?: Partial<import("./base.js").RateLimitConfig>;
    programmaticToolCalling?: boolean;
  } = {}) {
    super({
      model: model || "claude-sonnet-4-20250514",
      rateLimitConfig: rateLimitConfig || {
        requestsPerMinute: 50,
        requestsPerSecond: 5,
        maxConcurrent: 1,
        rateLimitBackoffMs: 5000,
      },
    });

    this.apiKey = apiKey || null;
    this.baseURL = (baseURL || "https://api.anthropic.com").replace(/\/+$/, "");
    this.programmaticToolCalling = programmaticToolCalling ?? false;
    this._containerId = null;

    if (!this.apiKey) {
      console.error("⚠️  No ANTHROPIC_API_KEY found. Set it via:");
      console.error("   export ANTHROPIC_API_KEY=your-key-here");
      console.error("   or use --api-key option");
    }
  }

  get name(): string {
    return "anthropic";
  }

  _headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "anthropic-version": "2023-06-01",
    };
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }
    return headers;
  }

  /**
   * Format a user-friendly error message based on HTTP status code.
   */
  _formatError(status: number, body = ""): string {
    const { message, actionable } = formatAPIError(status, body, "Anthropic", "ANTHROPIC_API_KEY");
    return actionable ? `${message}\n  → ${actionable}` : message;
  }

  /** Check if the current model supports server-side programmatic tool calling. */
  supportsProgrammaticToolCalling(): boolean {
    return AnthropicProvider.PROGRAMMATIC_MODELS.has(this._model);
  }

  /**
   * Convert generic tool format (Ollama/OpenAI style) to Anthropic's format.
   * When programmatic tool calling is enabled and the model supports it,
   * injects the code_execution tool and sets allowed_callers on other tools.
   */
  formatTools(tools: ToolDefinition[]): AnthropicTool[] {
    if (!tools || tools.length === 0) return [];

    const useProgrammatic = this.programmaticToolCalling && this.supportsProgrammaticToolCalling();

    const formatted = tools
      // Skip client-side code_execution when using server-side programmatic calling
      .filter(t => !(useProgrammatic && t.name === "code_execution"))
      .map(t => {
        const tool: AnthropicTool = {
          name: t.name,
          description: t.description,
          input_schema: (t.parameters as Record<string, unknown>) || { type: "object", properties: {} },
        };
        // When programmatic calling is enabled, mark tools as callable from code execution
        if (useProgrammatic) {
          tool.allowed_callers = ["code_execution_20260120"];
        }
        return tool;
      });

    // Prepend the Anthropic code execution tool
    if (useProgrammatic) {
      formatted.unshift({
        name: "code_execution",
        description: "Execute JavaScript code",
        input_schema: { type: "object", properties: {} },
      });
    }

    return formatted;
  }

  /**
   * Convert messages from the generic format to Anthropic's format.
   * Extracts the system message and converts tool messages to tool_result blocks.
   *
   * Tool result messages must include `tool_use_id` matching the prior assistant
   * `tool_use` block IDs. We derive those IDs by looking at the most recent
   * assistant message's tool_calls and correlating in order.
   */
  _convertMessages(messages: ChatMessage[]): ConvertedMessages {
    let system = "";
    const converted: AnthropicMessage[] = [];

    // Track pending tool_use IDs from the most recent assistant message so we
    // can assign them in order to subsequent tool result messages.
    let pendingToolUseIds: string[] = [];

    for (const msg of messages) {
      if (msg.role === "system") {
        system += (system ? "\n\n" : "") + (typeof msg.content === "string" ? msg.content : "");
        continue;
      }

      if (msg.role === "tool") {
        // Derive tool_use_id: prefer explicit field, then take from pending queue
        const toolUseId = (msg as unknown as { tool_use_id?: string }).tool_use_id
          || (pendingToolUseIds.length > 0 ? pendingToolUseIds.shift() : null)
          || `tool_result_${converted.length}`;

        // Anthropic expects tool results as user messages with tool_result content
        converted.push({
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: toolUseId,
            content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content),
            is_error: false,
          } as unknown as AnthropicContentBlock],
        });
        continue;
      }

      if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
        pendingToolUseIds = [];
        const content: AnthropicContentBlock[] = [];

        // Add text content if present
        if (msg.content && typeof msg.content === "string" && msg.content.trim()) {
          content.push({ type: "text", text: msg.content });
        }

        for (let i = 0; i < msg.tool_calls.length; i++) {
          const tc = msg.tool_calls[i];
          const id = tc.id || `tool_use_${converted.length}_${i}`;
          pendingToolUseIds.push(id);
          const block: AnthropicContentBlock = {
            type: "tool_use",
            id,
            name: tc.function.name,
            input: typeof tc.function.arguments === "string"
              ? JSON.parse(tc.function.arguments)
              : tc.function.arguments,
          };
          // Preserve caller metadata for programmatic tool calls
          if ((tc as unknown as { caller?: string }).caller) {
            block.caller = (tc as unknown as { caller: string }).caller;
          }
          content.push(block);
        }
        // Include code_execution_tool_result blocks if present
        const codeResults = (msg as unknown as { _codeExecutionResults?: AnthropicContentBlock[] })._codeExecutionResults;
        if (codeResults) {
          for (const cer of codeResults) {
            content.push(cer);
          }
        }
        converted.push({ role: "assistant", content });
        continue;
      }

      // Non-tool-call assistant or user messages reset the pending queue
      if (msg.role === "assistant") {
        pendingToolUseIds = [];
      }

      // Regular user/assistant messages
      converted.push({
        role: msg.role as "user" | "assistant",
        content: typeof msg.content === "string" ? msg.content : "",
      });
    }

    // Anthropic requires alternating user/assistant messages.
    // Merge consecutive same-role messages.
    const merged: AnthropicMessage[] = [];
    for (const msg of converted) {
      if (merged.length > 0 && merged[merged.length - 1].role === msg.role) {
        const prev = merged[merged.length - 1];
        if (typeof prev.content === "string" && typeof msg.content === "string") {
          prev.content += "\n\n" + msg.content;
        } else {
          // Convert to array form and append
          const prevContent = typeof prev.content === "string"
            ? [{ type: "text" as const, text: prev.content }]
            : prev.content;
          const newContent = typeof msg.content === "string"
            ? [{ type: "text" as const, text: msg.content }]
            : msg.content;
          prev.content = [...prevContent, ...newContent];
        }
      } else {
        merged.push({ ...msg });
      }
    }

    return { system, messages: merged };
  }

  /**
   * Extract tool calls and content from Anthropic response content blocks.
   * Also extracts server_tool_use and code_execution_tool_result blocks
   * for programmatic tool calling support.
   */
  _parseResponseContent(content: unknown): ParsedResponse {
    if (!Array.isArray(content)) {
      return { text: (content as string) || "", toolCalls: [], serverToolUses: [], codeExecutionResults: [] };
    }

    let text = "";
    const toolCalls: ParsedResponse["toolCalls"] = [];
    const serverToolUses: ParsedResponse["serverToolUses"] = [];
    const codeExecutionResults: ParsedResponse["codeExecutionResults"] = [];

    for (const block of content) {
      if (block.type === "text") {
        text += block.text;
      } else if (block.type === "tool_use") {
        const tc = {
          id: block.id,
          function: {
            name: block.name!,
            arguments: block.input || {},
          },
        };
        if (block.caller) {
          (tc as unknown as { caller: string }).caller = block.caller;
        }
        toolCalls.push(tc);
      } else if (block.type === "server_tool_use") {
        serverToolUses.push({
          id: block.id,
          name: block.name!,
          input: block.input || {},
        });
      } else if (block.type === "code_execution_tool_result") {
        codeExecutionResults.push(block);
        // Extract stdout as text for the model to see
        if (block.content?.stdout) {
          text += `\n[Code execution output]\n${block.content.stdout}`;
        }
        if (block.content?.stderr) {
          text += `\n[Code execution stderr]\n${block.content.stderr}`;
        }
      }
    }

    return { text, toolCalls, serverToolUses, codeExecutionResults };
  }

  async *chatStream(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
    maxTokens: number = DEFAULT_MAX_TOKENS,
    onRetry?: OnRetryCallback
  ): AsyncGenerator<StreamEvent & { serverToolUses?: unknown[]; codeExecutionResults?: unknown[] }> {
    const { system, messages: convertedMessages } = this._convertMessages(messages);
    const anthropicTools = this.formatTools(tools);

    const body: Record<string, unknown> = {
      model: this._model,
      max_tokens: maxTokens > 8192 ? 8192 : maxTokens,
      messages: convertedMessages,
      stream: true,
    };
    if (system) body.system = system;
    if (anthropicTools.length > 0) body.tools = anthropicTools;
    // Reuse code execution container if available
    if (this._containerId) body.container = this._containerId;

    const response = await this._withRetry(async () => {
      const resp = await fetch(`${this.baseURL}/v1/messages`, {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify(body),
        signal,
      });
      if (!resp.ok) {
        let errorBody = "";
        try { errorBody = await resp.text(); } catch { /* ignore */ }
        const err = new Error(this._formatError(resp.status, errorBody)) as Error & { status: number; body: string };
        err.status = resp.status;
        err.body = errorBody;
        throw err;
      }
      return resp;
    }, MAX_RETRIES, onRetry);

    const reader = response.body?.getReader();
    if (!reader) {
      yield { type: "done", toolCalls: [], tokenUsage: { promptTokens: 0, completionTokens: 0 } };
      return;
    }

    const decoder = new TextDecoder();
    let buffer = "";
    const toolCalls: Array<{ id?: string; function: { name: string; arguments: Record<string, unknown> } }> = [];
    const serverToolUses: Array<{ id?: string; name: string; input: Record<string, unknown> }> = [];
    const codeExecutionResults: AnthropicContentBlock[] = [];
    let currentToolUse: { id?: string; function: { name: string; arguments: Record<string, unknown> } } | null = null;
    let currentToolInput = "";
    let currentServerToolUse: { id?: string; name: string; input: Record<string, unknown> } | null = null;
    let currentServerToolInput = "";
    let currentBlockType: string | null = null;
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data: ")) continue;

          let data: Record<string, unknown>;
          try { data = JSON.parse(trimmed.slice(6)); } catch { continue; }

          switch (data.type as string) {
            case "content_block_start":
              if (data.content_block && typeof data.content_block === "object") {
                const block = data.content_block as Record<string, unknown>;
                if (block.type === "tool_use") {
                  currentBlockType = "tool_use";
                  currentToolUse = {
                    id: block.id as string,
                    function: { name: block.name as string, arguments: {} },
                  };
                  currentToolInput = "";
                } else if (block.type === "server_tool_use") {
                  currentBlockType = "server_tool_use";
                  currentServerToolUse = {
                    id: block.id as string,
                    name: block.name as string,
                    input: {},
                  };
                  currentServerToolInput = "";
                } else if (block.type === "code_execution_tool_result") {
                  currentBlockType = "code_execution_tool_result";
                  // Will be populated from content_block_stop or delta
                  codeExecutionResults.push(block as unknown as AnthropicContentBlock);
                } else {
                  currentBlockType = block.type as string;
                }
              }
              break;

            case "content_block_delta":
              if (data.delta && typeof data.delta === "object") {
                const delta = data.delta as Record<string, unknown>;
                if (delta.type === "text_delta" && delta.text) {
                  yield { type: "token", content: delta.text as string };
                }
                if (delta.type === "input_json_delta" && delta.partial_json) {
                  if (currentBlockType === "server_tool_use") {
                    currentServerToolInput += delta.partial_json as string;
                  } else {
                    currentToolInput += delta.partial_json as string;
                  }
                }
              }
              break;

            case "content_block_stop":
              if (currentBlockType === "tool_use" && currentToolUse) {
                try {
                  currentToolUse.function.arguments = JSON.parse(currentToolInput || "{}");
                } catch {
                  currentToolUse.function.arguments = {};
                }
                toolCalls.push(currentToolUse);
                currentToolUse = null;
                currentToolInput = "";
              } else if (currentBlockType === "server_tool_use" && currentServerToolUse) {
                try {
                  currentServerToolUse.input = JSON.parse(currentServerToolInput || "{}");
                } catch {
                  currentServerToolUse.input = {};
                }
                serverToolUses.push(currentServerToolUse);
                currentServerToolUse = null;
                currentServerToolInput = "";
              }
              currentBlockType = null;
              break;

            case "message_delta":
              // Usage info comes here
              if (data.usage && typeof data.usage === "object") {
                const usage = data.usage as Record<string, unknown>;
                completionTokens = (usage.output_tokens as number) || 0;
              }
              break;

            case "message_start":
              if (data.message && typeof data.message === "object") {
                const msg = data.message as Record<string, unknown>;
                if (msg.usage && typeof msg.usage === "object") {
                  const usage = msg.usage as Record<string, unknown>;
                  promptTokens = (usage.input_tokens as number) || 0;
                }
                // Track container ID for reuse
                if (msg.container && typeof msg.container === "object") {
                  const container = msg.container as Record<string, unknown>;
                  if (container.id) {
                    this._containerId = container.id as string;
                  }
                }
              }
              break;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    yield {
      type: "done",
      toolCalls,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      serverToolUses: serverToolUses as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      codeExecutionResults: codeExecutionResults as any,
      tokenUsage: { promptTokens, completionTokens },
    };
  }

  async chatWithRetry(
    messages: ChatMessage[],
    tools: ToolDefinition[],
    signal?: AbortSignal,
    maxTokens: number = DEFAULT_MAX_TOKENS,
    onRetry?: OnRetryCallback
  ): Promise<ChatResponse> {
    const { system, messages: convertedMessages } = this._convertMessages(messages);
    const anthropicTools = this.formatTools(tools);

    const body: Record<string, unknown> = {
      model: this._model,
      max_tokens: maxTokens > 8192 ? 8192 : maxTokens,
      messages: convertedMessages,
    };
    if (system) body.system = system;
    if (anthropicTools.length > 0) body.tools = anthropicTools;
    if (this._containerId) body.container = this._containerId;

    const respData = await this._withRetry(async () => {
      const resp = await fetch(`${this.baseURL}/v1/messages`, {
        method: "POST",
        headers: this._headers(),
        body: JSON.stringify(body),
        signal,
      });
      if (!resp.ok) {
        let errorBody = "";
        try { errorBody = await resp.text(); } catch { /* ignore */ }
        const err = new Error(this._formatError(resp.status, errorBody)) as Error & { status: number; body: string };
        err.status = resp.status;
        err.body = errorBody;
        throw err;
      }
      return resp.json();
    }, MAX_RETRIES, onRetry) as Record<string, unknown>;

    // Track container ID for reuse
    if (respData.container && typeof respData.container === "object") {
      const container = respData.container as Record<string, unknown>;
      if (container.id) {
        this._containerId = container.id as string;
      }
    }

    const { text, toolCalls, serverToolUses, codeExecutionResults } =
      this._parseResponseContent(respData.content);

    // Convert tool calls to normalized format (arguments as object)
    const normalizedToolCalls = toolCalls.map(tc => ({
      id: tc.id,
      function: {
        name: tc.function.name,
        arguments: tc.function.arguments,
      },
    }));

    const message = {
      content: text,
      tool_calls: normalizedToolCalls,
    };

    // Attach extra fields for internal use
    const result: ChatResponse & Record<string, unknown> = { message };
    if (serverToolUses.length > 0) {
      result._serverToolUses = serverToolUses;
    }
    if (codeExecutionResults.length > 0) {
      result._codeExecutionResults = codeExecutionResults;
    }

    return result;
  }

  async listModels(): Promise<string[]> {
    try {
      const resp = await fetch(`${this.baseURL}/v1/models`, {
        headers: this._headers(),
      });
      if (!resp.ok) return [];
      const data = await resp.json() as { data?: Array<{ id?: string }> };
      return (data.data || []).map(m => m.id || "");
    } catch {
      return [];
    }
  }

  /**
   * Check if this model supports vision (image inputs).
   * Claude 3+ models support vision. Claude 2 and earlier do not.
   */
  supportsVision(): boolean {
    const model = this._model.toLowerCase();
    // Claude 2 and earlier do not support vision
    if (model.startsWith('claude-2') || model.startsWith('claude-1') || model === 'claude-2' || model === 'claude-1') {
      return false;
    }
    // All Claude 3+ models support vision
    return true;
  }
}