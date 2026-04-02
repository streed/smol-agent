/**
 * Sub-agent tool — spawns a focused agent for research tasks.
 *
 * When the main agent needs to explore unfamiliar code, search across many files,
 * or gather information without polluting its context window, it can delegate
 * to a sub-agent with a clean context. The sub-agent has read-only tools and
 * returns a condensed result.
 *
 * Design:
 *   - Sub-agent starts with an empty context (no conversation history)
 *   - Only has read-only tools: read_file, list_files, grep, ask_user
 *   - Maximum 15 iterations to prevent runaway exploration
 *   - Tool results truncated to 4000 chars to stay small
 *   - Returns condensed summary to parent agent
 *
 * Key exports:
 *   - setSubAgentConfig(cfg): Configure with parent's provider/settings
 *   - Tool registration: delegate
 *
 * Dependencies: ./registry.js, ../logger.js, ../errors.js, ../tool-call-parser.js
 * Depended on by: src/acp-server.js, src/agent.js, src/ui/App.js, test/e2e/harness.js
 */
import { register } from "./registry.js";
import * as registry from "./registry.js";
import { logger } from "../logger.js";
import { isContextOverflowError } from "../errors.js";
import { parseToolCallsFromContent } from "../tool-call-parser.js";

interface SubAgentConfig {
  llmProvider?: unknown;
  maxTokens?: number;
  cwd?: string;
  signal?: AbortSignal;
  onProgress?: (event: ProgressEvent) => void;
}

interface ProgressEvent {
  type: string;
  task?: string;
  current?: number;
  max?: number;
  reason?: string;
  iterations?: number;
  tool?: string;
  error?: string;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  tool_calls?: ToolCall[];
}

interface ToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface ToolResult {
  [key: string]: unknown;
}

interface Provider {
  chatWithRetry: (
    messages: ChatMessage[],
    tools: unknown,
    signal: AbortSignal | undefined,
    maxTokens: number
  ) => Promise<{ message: ChatMessage }>;
}

// Config set by parent agent — updated per run with signal/progress callback
const config: {
  llmProvider: Provider | null;
  maxTokens: number;
  cwd: string;
  signal: AbortSignal | null;
  onProgress: ((event: ProgressEvent) => void) | null;
} = {
  llmProvider: null,
  maxTokens: 32768,
  cwd: process.cwd(),
  signal: null,
  onProgress: null,
};

/**
 * Configure the sub-agent with the parent agent's provider and settings.
 * Called from Agent constructor (for provider/cwd) and at each run()
 * start (for signal/onProgress).
 */
export function setSubAgentConfig(cfg: SubAgentConfig): void {
  if (cfg.llmProvider !== undefined) config.llmProvider = cfg.llmProvider as Provider;
  if (cfg.maxTokens !== undefined) config.maxTokens = Math.min(cfg.maxTokens, 32768);
  if (cfg.cwd !== undefined) config.cwd = cfg.cwd;
  if (cfg.signal !== undefined) config.signal = cfg.signal;
  if (cfg.onProgress !== undefined) config.onProgress = cfg.onProgress;
}

const READ_ONLY_TOOLS = new Set(["read_file", "list_files", "grep"]);
const MAX_ITERATIONS = 15;
const MAX_TOOL_RESULT_SIZE = 4000;

/**
 * Strip <thinking>...</thinking> tags from content to save context tokens.
 */
function stripThinking(content: string | null | undefined): string {
  if (!content) return content || "";
  return content.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim() || content;
}

/**
 * Prune messages to recover from context overflow.
 * Keeps system message + last few exchanges.
 */
function pruneMessages(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length <= 4) return messages;
  const system = messages[0];
  // Keep last 4 messages (2 exchanges)
  const recent = messages.slice(-4);
  return [system, ...recent];
}

interface DelegateArgs {
  task: string;
  context?: string;
}

interface DelegateResult {
  result?: string;
  error?: string;
}

register("delegate", {
  description:
    "Delegate a focused research subtask to a sub-agent with a clean context window. The sub-agent has read-only tools (read_file, list_files, grep) and returns a condensed result. Use for exploring unfamiliar code, searching across many files, or gathering information without polluting your main context.",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description:
          "Clear, specific description of what to research or find",
      },
      context: {
        type: "string",
        description:
          "Any relevant context the sub-agent needs (file paths, function names, etc.)",
      },
    },
    required: ["task"],
  },
  async execute({ task, context }: DelegateArgs): Promise<DelegateResult> {
    if (!config.llmProvider) {
      return {
        error:
          "Sub-agent not configured. Only available for 30B+ models.",
      };
    }

    // Use parent's provider
    const provider = config.llmProvider;
    const signal = config.signal;
    const onProgress = config.onProgress;

    const readOnlyTools = registry
      .getTools(true)
      .filter((t) => READ_ONLY_TOOLS.has(t.function.name));

    const systemPrompt = `You are a focused research sub-agent. Explore the codebase and return a concise answer.
Working directory: ${config.cwd}

Rules:
- Use tools to explore, then return a clear, concise summary.
- Keep your final answer under 1000 tokens.
- Focus only on the task given.
- Do NOT narrate — use tools immediately.
${context ? `\nContext: ${context}` : ""}`;

    const messages: ChatMessage[] = [
      { role: "system", content: systemPrompt },
      { role: "user", content: task },
    ];

    onProgress?.({ type: "start", task });

    try {
      for (let i = 0; i < MAX_ITERATIONS; i++) {
        // Check cancellation
        if (signal?.aborted) {
          return { error: "Sub-agent cancelled" };
        }

        onProgress?.({ type: "iteration", current: i + 1, max: MAX_ITERATIONS });

        let response;
        try {
          response = await provider.chatWithRetry(
            messages,
            readOnlyTools,
            signal,
            config.maxTokens,
          );
        } catch (err: unknown) {
          // Handle context overflow — prune and retry once
          const error = err as Error;
          if (isContextOverflowError(error) && messages.length > 4) {
            logger.warn("Sub-agent context overflow — pruning messages");
            onProgress?.({ type: "prune", reason: "context_overflow" });
            const pruned = pruneMessages(messages);
            messages.length = 0;
            messages.push(...pruned);
            // Retry this iteration
            try {
              response = await provider.chatWithRetry(
                messages, readOnlyTools, signal, config.maxTokens,
              );
            } catch (retryErr: unknown) {
              const retryError = retryErr as Error;
              logger.error(`Sub-agent failed after prune: ${retryError.message}`);
              return { error: `Sub-agent context overflow (unrecoverable): ${retryError.message}` };
            }
          } else {
            throw err;
          }
        }

        const msg = response.message;

        // Strip thinking tags to save context tokens
        const cleanedContent = stripThinking(msg.content);
        messages.push({ role: "assistant", content: cleanedContent, tool_calls: msg.tool_calls });

        // Check for tool calls — native first, then text parsing fallback
        let toolCalls = msg.tool_calls || [];
        if (toolCalls.length === 0 && cleanedContent) {
          toolCalls = parseToolCallsFromContent(cleanedContent) as ToolCall[];
        }

        if (toolCalls.length === 0) {
          onProgress?.({ type: "done", iterations: i + 1 });
          return { result: cleanedContent || "(no result)" };
        }

        // Execute read-only tool calls
        for (const tc of toolCalls) {
          const name = tc.function.name;
          const args = tc.function.arguments;

          if (signal?.aborted) {
            return { error: "Sub-agent cancelled" };
          }

          if (!READ_ONLY_TOOLS.has(name)) {
            messages.push({
              role: "user",
              content: `Error: Tool ${name} not available. Only read-only tools: ${[...READ_ONLY_TOOLS].join(", ")}`,
            });
            continue;
          }

          onProgress?.({ type: "tool", tool: name });

          try {
            const result = await registry.execute(name, args, { cwd: config.cwd }) as ToolResult;
            let resultStr = typeof result === "string" ? result : JSON.stringify(result, null, 2);

            // Truncate large results
            if (resultStr.length > MAX_TOOL_RESULT_SIZE) {
              resultStr = resultStr.slice(0, MAX_TOOL_RESULT_SIZE) + "\n...(truncated)";
            }

            messages.push({
              role: "user",
              content: resultStr,
            });
          } catch (toolErr: unknown) {
            const toolError = toolErr as Error;
            onProgress?.({ type: "error", error: toolError.message });
            messages.push({
              role: "user",
              content: `Error: ${toolError.message}`,
            });
          }
        }
      }

      onProgress?.({ type: "done", iterations: MAX_ITERATIONS });
      return { error: `Sub-agent exceeded ${MAX_ITERATIONS} iterations without completing` };
    } catch (err: unknown) {
      const error = err as Error;
      onProgress?.({ type: "error", error: error.message });
      return { error: `Sub-agent failed: ${error.message}` };
    }
  },
});