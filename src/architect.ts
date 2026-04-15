/**
 * Architect Mode — inspired by Aider and Kilocode.
 *
 * Separates planning from execution using a two-pass approach:
 *   1. Architect pass: Read-only analysis → produces a structured plan
 *   2. Editor pass: Executes the plan with write tools
 *
 * This prevents the agent from jumping straight into code changes
 * without understanding the problem, leading to better first-attempt
 * success rates.
 *
 * Can also be used standalone via the /architect command for
 * complex tasks where the user wants a plan before execution.
 *
 * Key exports:
 *   - runArchitectPass(client, model, task, cwd): Main entry point
 *   - ARCHITECT_SYSTEM_PROMPT: System prompt for architect mode
 *
 * Dependencies: ./ollama.js, ./tools/registry.js, ./tool-call-parser.js,
 *               ./logger.js, ./constants.js
 * Depended on by: src/agent.js, src/memory-bank.js, src/tools/memory.js,
 *                 src/tools/reflection.js, src/ui/App.js, test/e2e/scenarios/12-sub-agent.test.js
 */

import * as ollama from "./ollama.js";
import * as registry from "./tools/registry.js";
import { parseToolCallsFromContent } from "./tool-call-parser.js";
import { logger } from "./logger.js";
import { DEFAULT_MAX_TOKENS } from "./constants.js";
import type { ChatMessage, ToolDefinition } from "./ollama.js";

const READ_ONLY_TOOLS = new Set(["read_file", "list_files", "grep"]);

export const ARCHITECT_SYSTEM_PROMPT = `You are an architect agent that analyzes codebases and produces implementation plans.

## Your role
- Explore the codebase using read-only tools (read_file, list_files, grep)
- Understand the existing architecture, patterns, and conventions
- Produce a clear, actionable implementation plan

## Rules
- Use tools immediately — do NOT narrate "I will read..."
- Read relevant files to understand the codebase before planning
- Your final output must be a structured plan with:
  1. **Summary**: What needs to change and why
  2. **Files to modify**: List each file and what changes are needed
  3. **Files to create**: Any new files needed
  4. **Implementation order**: Which changes should be made first
  5. **Risks/considerations**: Edge cases, breaking changes, etc.
- Keep the plan concise and actionable — the editor agent will execute it
- Use <thinking>...</thinking> for internal reasoning`;

const MAX_ARCHITECT_ITERATIONS = 20;

export interface ArchitectOptions {
  cwd?: string;
  maxTokens?: number;
  projectContext?: string;
  signal?: AbortSignal | null;
  onProgress?: ((event: ArchitectProgressEvent) => void) | null;
}

export type ArchitectProgressEvent =
  | { type: "architect_start"; task: string }
  | { type: "architect_iteration"; current: number; max: number }
  | { type: "architect_done"; iterations: number }
  | { type: "architect_tool"; name: string; args: Record<string, unknown> };

/**
 * Run the architect pass: analyze the codebase and produce a plan.
 *
 * @param client - Ollama client
 * @param model - Model name
 * @param task - User's task description
 * @param options - Optional configuration
 * @returns The implementation plan
 */
export async function architectPass(
  client: unknown,
  model: string,
  task: string,
  options: ArchitectOptions = {}
): Promise<string> {
  const {
    cwd = process.cwd(),
    maxTokens = DEFAULT_MAX_TOKENS,
    projectContext = "",
    signal = null,
    onProgress = null,
  } = options;

  const systemContent = projectContext
    ? `${ARCHITECT_SYSTEM_PROMPT}\n\n# Project context\n\n${projectContext}`
    : ARCHITECT_SYSTEM_PROMPT;

  const messages: Array<{ role: string; content: string; tool_calls?: unknown[] }> = [
    { role: "system", content: systemContent },
    { role: "user", content: `Analyze the codebase and create an implementation plan for: ${task}` },
  ];

  // Only expose read-only tools
  const readOnlyTools = registry
    .ollamaTools(true)
    .filter((t: { function: { name: string } }) => READ_ONLY_TOOLS.has(t.function.name));

  onProgress?.({ type: "architect_start", task });

  for (let i = 0; i < MAX_ARCHITECT_ITERATIONS; i++) {
    if (signal?.aborted) {
      return "(Architect cancelled)";
    }

    onProgress?.({ type: "architect_iteration", current: i + 1, max: MAX_ARCHITECT_ITERATIONS });

    let response;
    try {
      // Cast client to expected type for backward-compatible API
      response = await ollama.chatWithRetry(
        client as Parameters<typeof ollama.chatWithRetry>[0],
        model,
        messages as ChatMessage[],
        // Cast through unknown since types don't overlap
        readOnlyTools as unknown as ToolDefinition[],
        signal as AbortSignal | undefined,
        maxTokens,
      );
    } catch (err) {
      const error = err as Error;
      logger.error(`Architect pass failed: ${error.message}`);
      return `(Architect failed: ${error.message})`;
    }

    const msg = response.message;

    // Strip thinking tags
    const content = msg.content
      ? msg.content.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim()
      : "";

    messages.push({ role: "assistant", content, tool_calls: msg.tool_calls as unknown[] | undefined });

    // Check for tool calls
    let toolCalls = (msg.tool_calls || []) as Array<{ function: { name: string; arguments: Record<string, unknown> } }>;
    if (toolCalls.length === 0 && content) {
      toolCalls = parseToolCallsFromContent(content)
        .filter(tc => READ_ONLY_TOOLS.has(tc.function.name));
    }

    // No tool calls → this is the final plan
    if (toolCalls.length === 0) {
      onProgress?.({ type: "architect_done", iterations: i + 1 });
      return content || "(No plan produced)";
    }

    // Execute read-only tool calls
    for (const tc of toolCalls) {
      const name = tc.function.name;
      const args = tc.function.arguments;

      if (!READ_ONLY_TOOLS.has(name)) {
        messages.push({
          role: "tool",
          content: JSON.stringify({ error: `Tool "${name}" not available in architect mode (read-only)` }),
        });
        continue;
      }

      onProgress?.({ type: "architect_tool", name, args });

      const result = await registry.execute(name, args, { cwd, eventEmitter: undefined, allowedTools: undefined });
      const str = JSON.stringify(result);
      // Truncate large results
      const truncated = str.length > 12000
        ? str.substring(0, 12000) + "\n[truncated]"
        : str;
      messages.push({ role: "tool", content: truncated });
    }
  }

  // Hit iteration limit — return last assistant content
  const lastAssistant = messages.filter(m => m.role === "assistant").pop();
  return lastAssistant?.content || "(Architect reached iteration limit)";
}

/**
 * Format an architect plan as a user message for the editor pass.
 * This is injected into the main agent's conversation so it has
 * the plan as context before making changes.
 */
export function formatPlanForEditor(plan: string, originalTask: string): string {
  return `## Implementation Plan (from architect analysis)

The following plan was produced by analyzing the codebase. Execute it step by step.

### Original task
${originalTask}

### Plan
${plan}

---
Execute this plan now. Make the changes described above, in the order specified. After each file change, verify it with read_file.`;
}