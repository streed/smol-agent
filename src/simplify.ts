/**
 * @file-doc Simplify Mode — analyzes current changes and suggests simplifications.
 *
 * Examines git diffs and uncommitted changes to identify opportunities for
 * code simplification, then produces a structured analysis with actionable
 * suggestions.
 *
 * Key exports:
 *   - simplifyPass(client, model, options): Main entry point
 *   - SIMPLIFY_SYSTEM_PROMPT: System prompt for simplify mode
 *   - gatherGitChanges(cwd): Get diff context for analysis
 *
 * Dependencies: ./ollama.js, ./tools/registry.js, ./tool-call-parser.js,
 *               ./logger.js, ./constants.js, node:child_process
 * Depended on by: src/ui/App.js
 */

import * as ollama from "./ollama.js";
import * as registry from "./tools/registry.js";
import { parseToolCallsFromContent } from "./tool-call-parser.js";
import { logger } from "./logger.js";
import { DEFAULT_MAX_TOKENS } from "./constants.js";
import { execFileSync } from "node:child_process";

const READ_ONLY_TOOLS = new Set(["read_file", "list_files", "grep"]);

export const SIMPLIFY_SYSTEM_PROMPT = `Analyze recent code changes and suggest simplifications.

Use read_file, list_files, grep to understand context. Output a prioritized list with file:line refs and before/after code.

Common simplification opportunities:
- Redundant code: duplicated logic, unnecessary variables
- Over-engineering: premature abstraction, excessive layers
- Complex conditionals: nested branches, inverted logic
- Dead code: unused imports, unreachable paths
- Verbose patterns: manual loops vs array methods, repeated checks
- Unnecessary complexity: over-nested callbacks, redundant error handling

For each issue, show the specific code location and concrete before/after.`;

const MAX_SIMPLIFY_ITERATIONS = 20;

interface GitChanges {
  diff: string;
  uncommitted: string;
}

interface SimplifyOptions {
  cwd?: string;
  maxTokens?: number;
  projectContext?: string;
  signal?: AbortSignal | null;
  onProgress?: ((event: SimplifyProgressEvent) => void) | null;
  scope?: string;
}

interface SimplifyProgressEvent {
  type: string;
  current?: number;
  max?: number;
  name?: string;
  args?: Record<string, unknown>;
  iterations?: number;
}

interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
}

interface ToolCall {
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

interface OllamaClient {
  chatWithRetry: (
    model: string,
    messages: ChatMessage[],
    tools: unknown[],
    signal: AbortSignal | null,
    maxTokens: number
  ) => Promise<{ message: ChatMessage }>;
}

/**
 * Detect the base branch that the current branch diverged from.
 * Tries main, then master, then falls back to HEAD~1.
 */
function detectBaseBranch(cwd: string): string {
  const opts = { cwd, maxBuffer: 10 * 1024, timeout: 10_000 };

  // Get current branch name
  let currentBranch = "";
  try {
    currentBranch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], opts).toString().trim();
  } catch { /* empty */ }

  // If we're on main/master itself, fall back to HEAD~1
  if (currentBranch === "main" || currentBranch === "master") {
    return "HEAD~1";
  }

  // Try to find the merge-base with common default branches
  for (const base of ["main", "master"]) {
    try {
      const mergeBase = execFileSync(
        "git", ["merge-base", base, "HEAD"],
        opts,
      ).toString().trim();
      if (mergeBase) return mergeBase;
    } catch { /* branch doesn't exist, try next */ }
  }

  // Fallback: diff against HEAD~1
  return "HEAD~1";
}

/**
 * Gather changes in the current branch for simplification analysis.
 * Compares the current branch against its base (main/master) to show
 * all changes introduced by this branch, including uncommitted work.
 */
export function gatherGitChanges(cwd: string): GitChanges {
  const opts = { cwd, maxBuffer: 200 * 1024, timeout: 15_000 };

  const base = detectBaseBranch(cwd);
  let diff = "";
  let uncommitted = "";

  // All committed changes on this branch since diverging from base
  try {
    diff = execFileSync("git", ["diff", base, "HEAD"], opts).toString();
  } catch {
    // Fallback for fresh repos or missing base
    try {
      diff = execFileSync("git", ["diff", "HEAD~1", "HEAD"], opts).toString();
    } catch { /* empty */ }
  }

  // Uncommitted changes (staged + unstaged) on top of HEAD
  try {
    const uncommittedDiff = execFileSync("git", ["diff", "HEAD"], opts).toString();
    if (uncommittedDiff.trim()) {
      uncommitted = uncommittedDiff;
    }
  } catch { /* empty */ }

  return { diff, uncommitted };
}

/**
 * Run the simplify pass: analyze recent changes and suggest simplifications.
 */
export async function simplifyPass(
  client: OllamaClient,
  model: string,
  options: SimplifyOptions = {}
): Promise<string> {
  const {
    cwd = process.cwd(),
    maxTokens = DEFAULT_MAX_TOKENS,
    projectContext = "",
    signal = null,
    onProgress = null,
    scope = "",
  } = options;

  const { diff, uncommitted } = gatherGitChanges(cwd);

  if (!diff && !uncommitted) {
    return "(No changes found to analyze. Make some changes first.)";
  }

  // Build the user prompt with the git context
  let changesSection = "";
  if (diff) {
    changesSection += `## Committed changes\n\`\`\`diff\n${diff}\n\`\`\`\n\n`;
  }
  if (uncommitted) {
    changesSection += `## Uncommitted changes\n\`\`\`diff\n${uncommitted}\n\`\`\`\n\n`;
  }

  const scopeHint = scope ? `\nFocus your analysis on: ${scope}\n` : "";

  const userPrompt = `Analyze the following recent changes and identify opportunities to simplify the code.${scopeHint}

${changesSection}
Read the relevant source files for additional context, then produce your simplification analysis.`;

  const systemContent = projectContext
    ? `${SIMPLIFY_SYSTEM_PROMPT}\n\n# Project context\n\n${projectContext}`
    : SIMPLIFY_SYSTEM_PROMPT;

  const messages: ChatMessage[] = [
    { role: "system", content: systemContent },
    { role: "user", content: userPrompt },
  ];

  // Only expose read-only tools
  const readOnlyTools = registry.ollamaTools(true)
    .filter((t) => READ_ONLY_TOOLS.has(t.function.name));

  // Cast through unknown for type compatibility with ollama.chatWithRetry
  const tools = readOnlyTools as unknown as Parameters<typeof ollama.chatWithRetry>[3];

  onProgress?.({ type: "simplify_start" });

  for (let i = 0; i < MAX_SIMPLIFY_ITERATIONS; i++) {
    if (signal?.aborted) {
      return "(Simplify analysis cancelled)";
    }

    onProgress?.({ type: "simplify_iteration", current: i + 1, max: MAX_SIMPLIFY_ITERATIONS });

    let response;
    try {
      response = await ollama.chatWithRetry(
        client as Parameters<typeof ollama.chatWithRetry>[0],
        model,
        messages as Parameters<typeof ollama.chatWithRetry>[2],
        tools,
        signal,
        maxTokens,
      );
    } catch (err: unknown) {
      const error = err as Error;
      logger.error(`Simplify pass failed: ${error.message}`);
      return `(Simplify analysis failed: ${error.message})`;
    }

    const msg = response.message;

    // Strip thinking tags
    const content = msg.content
      ? msg.content.replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim()
      : "";

    messages.push({ role: "assistant", content, tool_calls: msg.tool_calls });

    // Check for tool calls
    let toolCalls = msg.tool_calls || [];
    if (toolCalls.length === 0 && content) {
      toolCalls = parseToolCallsFromContent(content)
        .filter(tc => READ_ONLY_TOOLS.has(tc.function.name)) as ToolCall[];
    }

    // No tool calls → this is the final analysis
    if (toolCalls.length === 0) {
      onProgress?.({ type: "simplify_done", iterations: i + 1 });
      return content || "(No simplification analysis produced)";
    }

    // Execute read-only tool calls
    for (const tc of toolCalls) {
      const name = tc.function.name;
      const args = tc.function.arguments;

      if (!READ_ONLY_TOOLS.has(name)) {
        messages.push({
          role: "tool",
          content: JSON.stringify({ error: `Tool "${name}" not available in simplify mode (read-only)` }),
        });
        continue;
      }

      onProgress?.({ type: "simplify_tool", name, args });

      const result = await registry.execute(name, args, { cwd });
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
  return lastAssistant?.content || "(Simplify analysis reached iteration limit)";
}